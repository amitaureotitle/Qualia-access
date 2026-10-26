import { Driver, clickFound, openOrder } from "./driver";

/**
 * Title > Final Policy: press "Print" on each given (already issued) policy.
 *
 * Fallback for the closeout workflow: sometimes a policy is issued but Qualia
 * never creates its "Full ... Policy" PDF in Documents (2026-MI-357,
 * 2026-10-26). Pressing Print makes Qualia generate the files (per the user).
 * With both an owner and a lender policy, each is printed separately: select
 * its tab ("Owner's Policy" / "Lender's Policy"), then press the Print next to
 * Void in that policy's side panel.
 *
 * Not irreversible -- it only (re)generates files -- so there's no commit():
 * a failure is safe to retry. Whether the PDFs now exist is checked by the
 * caller from Qualia's API.
 */

export interface PolicyRef {
  index: number;
  kind: "owner" | "lender";
}

export interface PrintResult {
  status: "printed" | "error";
  printed?: string[];
  detail?: string;
}

// The policy's tab on the left of the Final Policy page.
const TAB_TEXT: Record<PolicyRef["kind"], RegExp> = {
  owner: /^owner'?s policy$/i,
  lender: /^(lender'?s|loan) policy$/i,
};

// Wait after each Print for Qualia to create the files before moving on.
const AFTER_PRINT_MS = 10_000;

/** JS expression: the visible tab whose text matches `re`, or a string listing what tabs exist. */
function tabExpr(re: RegExp): string {
  return `(function() {
    var re = ${re.toString()};
    var seen = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.offsetParent === null || el.children.length) continue;
      var t = (el.textContent || '').trim();
      if (/polic/i.test(t) && t.length < 40) seen.push(t);
      if (re.test(t)) return el;
    }
    return 'no tab among: ' + seen.join(' | ');
  })()`;
}

/** JS expression: the visible "Print" button paired with "Void" (the issued policy's buttons). */
const PRINT_EXPR = `(function() {
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.offsetParent === null || el.children.length || (el.textContent || '').trim() !== 'Print') continue;
    var btn = el.closest('button, .button, a') || el;
    var group = btn.parentElement;
    if (group && /\\bVoid\\b/.test(group.textContent || '')) return btn;
  }
  return null;
})()`;

export async function printPoliciesStep(d: Driver, orderId: string, policies: PolicyRef[]): Promise<PrintResult> {
  await openOrder(d, orderId, "title/final_policy");
  if (!(await d.waitFor(`!!document.querySelector('[data-schema-key^="title.policies."]')`, 45_000))) {
    return { status: "error", detail: "Final Policy page never showed any policy fields." };
  }
  const printed: string[] = [];
  for (const p of policies) {
    d.note(`Printing the ${p.kind} policy`);
    const tab = await clickFound(d, tabExpr(TAB_TEXT[p.kind]), `Select the ${p.kind} policy tab`, "mouse");
    if (tab !== "clicked") {
      // An owner-only order may show its single policy without a tab to pick.
      if (policies.length > 1 || p.kind !== "owner") {
        return { status: "error", printed, detail: `${p.kind} policy tab: ${tab}` };
      }
      d.note(`No owner tab to select (${tab}) -- printing the policy shown`);
    }
    if (!(await d.waitFor(`!!${PRINT_EXPR}`, 15_000))) {
      return { status: "error", printed, detail: `No "Print" button next to "Void" for the ${p.kind} policy -- is it issued?` };
    }
    const r = await clickFound(d, PRINT_EXPR, `Click "Print" (${p.kind} policy)`);
    if (r !== "clicked") return { status: "error", printed, detail: `${p.kind} policy "Print": ${r}` };
    // Stay on the page while Qualia generates the files; leaving right away
    // may be what stopped them being created after Issue.
    d.note("Waiting for Qualia to create the policy files");
    await d.sleep(AFTER_PRINT_MS);
    printed.push(p.kind);
  }
  return { status: "printed", printed };
}
