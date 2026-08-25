import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";

export type PolicyKind = "owner" | "lender";

export interface PreparePolicyResult {
  status: "ready" | "missing_instrument" | "error";
  policies: PolicyKind[];
  detail?: string;
}

// Confirmed live 2026-08-25 against order 2026-MO-300 (KaWBppJm73dxNkX6C):
// each policy panel's fields live under data-schema-key
// "title.policies.<index>.<field>" -- index 0 is always Owner's Policy,
// index 1 (only present when a lender exists) is Lender's Policy. Cash
// deals only have index 0. This is far more reliable than matching the
// visible heading text, which turned out not to be a plain leaf text node
// (an earlier text-based selector attempt found zero matches for it).
const POLICY_ORDER: PolicyKind[] = ["owner", "lender"];

async function policyIndexes(page: Page): Promise<number[]> {
  const indexes: string = await page.evaluate(`
    (function() {
      var seen = {};
      document.querySelectorAll('[data-schema-key^="title.policies."]').forEach(function(el) {
        var m = el.getAttribute('data-schema-key').match(/^title\\.policies\\.(\\d+)\\./);
        if (m) seen[m[1]] = true;
      });
      return Object.keys(seen).sort().join(",");
    })()
  `);
  return indexes ? indexes.split(",").map(Number) : [];
}

async function checkIfUnchecked(page: Page, schemaKey: string): Promise<void> {
  const input = page.locator(`input[data-schema-key="${schemaKey}"]`);
  const wrapper = page.locator(`.ui.checkbox:has(input[data-schema-key="${schemaKey}"])`);
  // Wait for the field to actually be attached before reading its state --
  // a fresh login + first navigation to this page can be slower than a
  // flat post-navigation wait accounts for (seen live 2026-08-25: a
  // same-session re-check landed instantly, a fresh-login run needed
  // longer). Let this throw if the field never shows up at all -- that's a
  // real "page didn't load as expected" error, not something to swallow.
  try {
    await input.waitFor({ state: "attached", timeout: 45_000 });
  } catch (err) {
    const url = page.url();
    const bodySnippet = await page.evaluate("document.body.innerText.slice(0, 300)").catch(() => "");
    throw new Error(`waiting for ${schemaKey} -- current url: ${url} -- body starts: ${JSON.stringify(bodySnippet)}`);
  }
  const isChecked = await input.isChecked();
  if (!isChecked) {
    await wrapper.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Navigate to Title > Final Policy, detect which policies exist (cash deals
 * have index 0 / Owner's Policy only), toggle "Use Recording Date"
 * (policy_use_effective_time_text) and "Include Endorsements on Policy"
 * (policy_concat_endorsements) on for each present policy index, and verify
 * the Recorded Instruments section at the bottom of the page is populated.
 *
 * Does NOT click Issue -- see issue-final-policies.ts for that, gated
 * separately behind the Python side's claim guard.
 */
export async function prepareFinalPolicy(page: Page, orderId: string): Promise<PreparePolicyResult> {
  await navigateToOrder(page, orderId, "title/final_policy");
  await dismissStartupModals(page);
  // Wait for the page to actually render policy fields rather than a flat
  // timeout -- a fresh login + first navigation can take noticeably longer
  // than a warm session (see checkIfUnchecked's comment).
  await page.locator('[data-schema-key^="title.policies."]').first().waitFor({ state: "attached", timeout: 45_000 }).catch(() => {});

  const indexes = await policyIndexes(page);
  if (indexes.length === 0) {
    return { status: "error", policies: [], detail: "No title.policies.* fields found on the Final Policy page." };
  }

  const policies: PolicyKind[] = indexes.map((i) => POLICY_ORDER[i] ?? "owner");

  for (const i of indexes) {
    await checkIfUnchecked(page, `title.policies.${i}.policy_use_effective_time_text`);
    await checkIfUnchecked(page, `title.policies.${i}.policy_concat_endorsements`);
  }
  await page.waitForTimeout(1_000);

  const instrumentSection = page.getByText("Recorded Instruments", { exact: false });
  const hasInstrumentSection = await instrumentSection.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!hasInstrumentSection) {
    return {
      status: "missing_instrument",
      policies,
      detail: "No Recorded Instruments section found on the Final Policy page.",
    };
  }

  return { status: "ready", policies };
}
