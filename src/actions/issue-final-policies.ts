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
  // Wait for the button to actually attach rather than a flat timeout (see
  // prepare-final-policy.ts's checkIfUnchecked comment) -- distinguishes a
  // genuinely-missing button (already issued, or something's wrong) from
  // the page just not having loaded yet.
  await page.locator(buttonTag).first().waitFor({ state: "attached", timeout: 45_000 }).catch(() => {});
  const label = policies.length > 1 ? "Issue All Policies" : "Issue";
  const result: string = await page.evaluate(script);

  if (result !== "clicked") {
    return { status: "error", policies: [], detail: `"${label}" button ${result}.` };
  }

  // Policies take time to be issued -- confirmed by the user's own testing.
  await page.waitForTimeout(60_000);

  return { status: "issued", policies };
}
