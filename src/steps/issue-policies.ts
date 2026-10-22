import { Driver, clickFound, openOrder } from "./driver";

/**
 * Title > Final Policy: prepare each policy panel, then issue.
 *
 * Per policy present (Qualia's schema index 0 = owner, 1 = lender; cash
 * deals only have 0):
 *   1. Effective Date / Effective Time <- the matching recorded instrument's
 *      recording date/time (owner: deed, lender: deed of trust), read from
 *      the Recording page by read-recording.ts and passed in by the caller.
 *   2. Tick "Use Recording Date" (policy_use_effective_time_text) and
 *      "Include Endorsements on Policy" (policy_concat_endorsements) --
 *      schema keys confirmed live 2026-08-25 by the deleted
 *      prepare-final-policy.ts.
 * Then "Issue All Policies" (<issueallpolicies>) when there's a lender, or
 * the single "Issue" (<issuepolicy>) for an owner-only policy -- waiting for
 * the button to be attached AND enabled first (the 2026-09-17 race fix).
 *
 * rehearse (dry run): the fields and checkboxes are really filled in, exactly
 * as live (per the user, 2026-10-22: a dry run should change everything on
 * screen) -- note Qualia saves these on change, there's no form to submit.
 * Only the irreversible Issue click is skipped: the button is outlined with
 * "Would click" instead.
 *
 * Issuance itself is confirmed by the caller from Qualia's API
 * (Policy.issuedDate + the "Full ... Policy" documents), never assumed here.
 */

export interface PolicyPrep {
  index: number;
  kind: "owner" | "lender";
  effectiveDate?: string | null; // "10/21/2026"
  effectiveTime?: string | null; // "2:15 PM"
}

export interface IssueResult {
  status: "clicked" | "rehearsed" | "error";
  button?: string;
  prepared?: string[];
  detail?: string;
}

const CHECKBOXES: [string, string][] = [
  ["policy_use_effective_time_text", "Use Recording Date"],
  ["policy_concat_endorsements", "Include Endorsements on Policy"],
];

const MARK = "data-wf-field";

/**
 * Find the effective date/time input of policy `index` and tag it; returns a
 * selector for it, or an error listing the policy's schema keys (so a wrong
 * guess about Qualia's field names shows up in the log, not as a silent skip).
 */
async function markEffectiveInput(d: Driver, index: number, which: "date" | "time"): Promise<{ selector?: string; error?: string }> {
  const tag = `p${index}-${which}`;
  const res = await d.evaluate<string>(`
    (function() {
      var prefix = 'title.policies.${index}.';
      var inputs = Array.from(document.querySelectorAll('input[data-schema-key^="' + prefix + '"]'));
      var keys = inputs.map(function(i) { return i.getAttribute('data-schema-key'); });
      var want = ${JSON.stringify(which)};
      var hit = inputs.find(function(i) {
        var k = i.getAttribute('data-schema-key').slice(prefix.length).toLowerCase();
        if (i.type === 'checkbox' || k.indexOf('effective') === -1 || k.indexOf('use_effective') !== -1) return false;
        return want === 'date' ? k.indexOf('date') !== -1 : k.indexOf('time') !== -1 && k.indexOf('date') === -1;
      });
      if (!hit) return JSON.stringify({ error: 'no effective ' + want + ' input among: ' + keys.join(', ') });
      hit.setAttribute('${MARK}', '${tag}');
      return JSON.stringify({ selector: '[${MARK}="${tag}"]', key: hit.getAttribute('data-schema-key') });
    })()
  `);
  return JSON.parse(res);
}

async function setEffective(d: Driver, p: PolicyPrep, which: "date" | "time", value: string): Promise<string | null> {
  const label = `${p.kind} policy Effective ${which === "date" ? "Date" : "Time"}`;
  const found = await markEffectiveInput(d, p.index, which);
  if (!found.selector) return `${label}: ${found.error}`;
  const current = await d.evaluate<string>(`(document.querySelector('${found.selector}') || {}).value || ''`);
  if (current.trim().toUpperCase() === value.toUpperCase()) {
    d.note(`${label} already ${value}`);
    return null;
  }
  await d.click(found.selector, { label: `Set ${label}: ${current || "(empty)"} → ${value}` });
  await d.evaluate(`document.querySelector('${found.selector}').select()`);
  await d.type(value, `Type ${value}`);
  // Leave the field without Tab: Tab focuses the next date input and opens its
  // calendar, which then covers the checkboxes below (seen live 2026-10-22 on
  // 2026-MO-410). Escape closes this field's picker; blur() commits the value.
  await d.press("Escape");
  await closePickers(d, found.selector);
  await d.sleep(500);
  const after = await d.evaluate<string>(`(document.querySelector('${found.selector}') || {}).value || ''`);
  if (after.trim().toUpperCase() !== value.toUpperCase()) {
    return `${label}: typed ${value} but the field reads ${JSON.stringify(after)}`;
  }
  return null;
}

/** Blur the focused field (commits a typed value) so any open date picker closes. */
async function closePickers(d: Driver, selector?: string): Promise<void> {
  await d.evaluate(`
    (function() {
      var el = ${selector ? `document.querySelector('${selector}')` : "null"} || document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
      return true;
    })()
  `);
  await d.sleep(300);
}

async function ensureChecked(d: Driver, p: PolicyPrep, key: string, label: string): Promise<string | null> {
  const schemaKey = `title.policies.${p.index}.${key}`;
  const state = await d.evaluate<string>(`
    (function() {
      var input = document.querySelector('input[data-schema-key="${schemaKey}"]');
      if (!input) return 'missing';
      return input.checked ? 'checked' : 'unchecked';
    })()
  `);
  const full = `"${label}" (${p.kind} policy)`;
  if (state === "missing") return `${full}: checkbox ${schemaKey} not found`;
  if (state === "checked") {
    d.note(`${full} already checked`);
    return null;
  }
  await closePickers(d);
  const wrapper = `(function(){ var i = document.querySelector('input[data-schema-key="${schemaKey}"]'); return i && (i.closest('.ui.checkbox') || i.parentElement); })()`;
  const r = await clickFound(d, wrapper, `Check ${full}`, "mouse");
  if (r !== "clicked") return `${full}: ${r}`;
  await d.sleep(500);
  const after = await d.evaluate<boolean>(`!!(document.querySelector('input[data-schema-key="${schemaKey}"]') || {}).checked`);
  return after ? null : `${full}: clicked but still unchecked`;
}

export async function issuePoliciesStep(
  d: Driver,
  orderId: string,
  policyCount: number,
  opts: { rehearse?: boolean; policies?: PolicyPrep[] } = {}
): Promise<IssueResult> {
  const rehearse = !!opts.rehearse;
  await openOrder(d, orderId, "title/final_policy");
  if (!(await d.waitFor(`!!document.querySelector('[data-schema-key^="title.policies."]')`, 45_000))) {
    return { status: "error", detail: "Final Policy page never showed any policy fields." };
  }

  // 1-2. Prepare each policy panel.
  const prepared: string[] = [];
  for (const p of opts.policies ?? []) {
    d.note(`Preparing the ${p.kind} policy`);
    if (!p.effectiveDate || !p.effectiveTime) {
      return { status: "error", prepared, detail: `No recording date/time known for the ${p.kind} policy.` };
    }
    for (const [which, value] of [["date", p.effectiveDate], ["time", p.effectiveTime]] as const) {
      const err = await setEffective(d, p, which, value);
      if (err) return { status: "error", prepared, detail: err };
    }
    for (const [key, label] of CHECKBOXES) {
      const err = await ensureChecked(d, p, key, label);
      if (err) return { status: "error", prepared, detail: err };
    }
    prepared.push(`${p.kind}: ${p.effectiveDate} ${p.effectiveTime}, both boxes`);
  }

  // 3. Issue.
  const tag = policyCount > 1 ? "issueallpolicies" : "issuepolicy";
  const label = policyCount > 1 ? "Issue All Policies" : "Issue";
  d.note(`Waiting for "${label}" to become enabled`);
  await d.waitFor(
    `(function(){ var b = document.querySelector('${tag}'); return !!b && !b.classList.contains('disabled'); })()`,
    45_000
  );
  const state = await d.evaluate<string>(`
    (function() {
      var b = document.querySelector('${tag}');
      if (!b) return 'not found';
      return b.classList.contains('disabled') ? 'disabled' : 'ready';
    })()
  `);

  if (rehearse) {
    if (state === "not found") return { status: "error", button: label, prepared, detail: `"${label}" button not found.` };
    const note = state === "disabled" ? " (still disabled -- live would fail here too)" : "";
    await d.show(tag, `Would click "${label}" (dry run)${note}`);
    return { status: "rehearsed", button: label, prepared, detail: `Dry run: fields filled in, "${label}" not clicked${note}` };
  }
  if (state !== "ready") return { status: "error", button: label, prepared, detail: `"${label}" button ${state}.` };

  await d.commit(`Click "${label}"`);
  d.note(`Clicking "${label}"`);
  // Qualia renders these as custom elements; element.click() ("dom")
  // handles them more reliably than a synthesized mouse click.
  const result = await clickFound(
    d,
    `(function(){ var b = document.querySelector('${tag}'); if (!b) return null; return b.classList.contains('disabled') ? 'disabled' : b; })()`,
    `Click "${label}"`
  );
  if (result !== "clicked") {
    // clickFound only fails before clicking, so this is safe to retry.
    return { status: "error", button: label, prepared, detail: `"${label}" button ${result} at click time.` };
  }
  // Give Qualia a moment to accept the click; issuance itself is confirmed
  // by the caller from the API.
  await d.sleep(5_000);
  return { status: "clicked", button: label, prepared };
}
