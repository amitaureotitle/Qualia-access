import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";
import type { PolicyKind } from "./prepare-final-policy";

export interface IssueResult {
  status: "issued" | "error";
  policies: PolicyKind[];
  detail?: string;
}

// Confirmed live 2026-08-25 against order 2026-MO-300: Qualia renders these
// as custom elements (<issueallpolicies>, <issuepolicy>), same pattern as
// <uploadcommitment>/<submitcommitment> elsewhere in this repo -- click via
// evaluate rather than a Playwright locator .click(), which doesn't handle
// these reliably.
const CLICK_ISSUE_ALL = `
  (function() {
    var btn = document.querySelector('issueallpolicies');
    if (!btn) return 'not found';
    if (btn.classList.contains('disabled')) return 'disabled';
    btn.click();
    return 'clicked';
  })()
`;

const CLICK_ISSUE_SINGLE = `
  (function() {
    var btn = document.querySelector('issuepolicy');
    if (!btn) return 'not found';
    if (btn.classList.contains('disabled')) return 'disabled';
    btn.click();
    return 'clicked';
  })()
`;

// String form (not a JS function reference) so this evaluates in the page's
// own realm, same as the CLICK_* scripts above -- a real function reference
// would need DOM lib types this repo's tsconfig doesn't include.
const WAIT_ENABLED = (tag: string) => `
  (function() {
    var btn = document.querySelector('${tag}');
    return !!btn && !btn.classList.contains('disabled');
  })()
`;

/**
 * Click "Issue All Policies" (two policies) or the single "Issue" button
 * (cash deal, owner's policy only), then wait for Qualia to actually issue
 * them before returning. This is the irreversible step -- only ever called
 * after prepare-final-policy.ts has returned "ready" AND the Python side has
 * taken the post_closing_issue_policies claim, never speculatively.
 */
export async function issueFinalPolicies(page: Page, orderId: string, policies: PolicyKind[]): Promise<IssueResult> {
  await navigateToOrder(page, orderId, "title/final_policy");
  await dismissStartupModals(page);

  const script = policies.length > 1 ? CLICK_ISSUE_ALL : CLICK_ISSUE_SINGLE;
  const buttonTag = policies.length > 1 ? "issueallpolicies" : "issuepolicy";
  const label = policies.length > 1 ? "Issue All Policies" : "Issue";
  // Wait for the button to actually attach AND become enabled, not just
  // attach -- confirmed live 2026-09-17 (real incidents on 2026-MO-306,
  // 265, 317, 305, 276) that the button routinely attaches to the DOM
  // still `disabled` for some interval after page load (Qualia's own
  // async enable check hasn't finished yet), and the old code below only
  // waited for attachment then read `disabled` synchronously -- a race
  // that made nearly every FIRST attempt on a real order come back as a
  // clean "button disabled" error (HTTP 200, not a timeout -- see
  // AUTOMATIONS.md #1b) instead of a real click. Polling for
  // "attached and not disabled" here removes that race; a button that's
  // still disabled after the full timeout is now a genuine error, not a
  // premature check.
  await page.waitForFunction(WAIT_ENABLED(buttonTag), { timeout: 45_000 }).catch(() => {});
  const result: string = await page.evaluate(script);

  if (result !== "clicked") {
    return { status: "error", policies: [], detail: `"${label}" button ${result}.` };
  }

  // Policies take time to be issued -- confirmed by the user's own testing.
  await page.waitForTimeout(60_000);

  return { status: "issued", policies };
}
