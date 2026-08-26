import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";
import type { PolicyKind } from "./prepare-final-policy";

export interface SendTrailingDocsResult {
  status: "sent" | "error";
  recipients?: string[];
  attachments?: string[];
  detail?: string;
}

const RECIPIENT_ROLE_MATCHERS: Record<PolicyKind, string[]> = {
  // Unconfirmed against a non-LLC order -- "Borrower Representative" is
  // what 2026-MO-300 (an LLC buyer) actually shows; "Buyer" is the user's
  // best guess for an individual-buyer order's real label, not yet seen.
  owner: ["Borrower Representative", "Buyer"],
  lender: ["Lender"],
};

const RECORDED_DOCUMENTS_FOLDER = "Recorded documents";
const FULL_POLICY_NAMES: Record<PolicyKind, string> = {
  owner: "Full Owner Policy",
  lender: "Full Lender Policy",
};

/**
 * Confirmed live 2026-08-26 against order 2026-MO-300:
 * - The modal is a custom element <sendemailpopup>.
 * - Subject: input[data-schema-key="subject"].
 * - Recipients: click the leaf "Recipients" text to open the dropdown, then
 *   click each item whose text contains a wanted role label -- confirmed
 *   working (selected chips appeared for both Borrower Representative and
 *   Lender).
 * - Attachment picker: a ".scrolling.menu" listing every Documents-tab
 *   file; each item's text is "<filename> <folder>" concatenated (no
 *   separator). The recorded deed/DOT live under folder "Recorded
 *   documents" (lowercase d); the issued policies are named exactly "Full
 *   Owner Policy" / "Full Lender Policy" (distinct from "Owner's Policy
 *   Jacket" or "... Schedules + Endorsements", which are different files).
 *
 * NOT yet independently live-verified: that clicking an attachment item
 * actually selects it (inferred from recipients' proven click-to-select
 * behavior, not directly observed), and the "via" dropdown's click-to-switch
 * mechanism. Always dry-run with composeOnly: true first and inspect the
 * returned recipients/attachments before ever calling with composeOnly:
 * false -- clicking Send is a real, irreversible email to the buyer/lender.
 */
export async function sendTrailingDocuments(
  page: Page,
  orderId: string,
  address: string,
  policies: PolicyKind[],
  opts: { composeOnly?: boolean; ownerEmailOverride?: string } = {}
): Promise<SendTrailingDocsResult> {
  await navigateToOrder(page, orderId, "dashboard");
  await dismissStartupModals(page);
  await page.waitForTimeout(3_000);

  const openResult: string = await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
        if (txt === 'Send Message' && el.offsetParent !== null) { el.click(); return 'clicked'; }
      }
      return 'not found';
    })()
  `);
  if (openResult !== "clicked") {
    return { status: "error", detail: `"Send Message" button ${openResult}.` };
  }

  await page.locator("sendemailpopup").waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForTimeout(1_000);

  const subject = `Trailing documents for ${address}`;
  const subjectResult: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var input = panel.querySelector('input[data-schema-key="subject"]');
      if (!input) return 'no subject input';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(subject)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()
  `);
  if (subjectResult !== "filled") {
    return { status: "error", detail: `Subject fill failed: ${subjectResult}` };
  }

  // For the owner side, some source-of-business entities want documents
  // routed to a designated mailbox instead of the on-order contact -- see
  // config/policies/post_closing_recipients.json (Python side resolves the
  // company -> email mapping, passes the email itself here). That mailbox
  // must already exist as a Contact on the order (Qualia's Recipients field
  // only offers existing contacts, confirmed live 2026-08-26 -- typing a
  // free-form email produced no "Add" option, with both a raw JS value-set
  // and real simulated keystrokes), matched here by email substring instead
  // of role text.
  const wantedRoles = policies.flatMap((p) =>
    p === "owner" && opts.ownerEmailOverride ? [opts.ownerEmailOverride] : RECIPIENT_ROLE_MATCHERS[p]
  );
  const recipientsOpen: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var recipientsDefault = null;
      panel.querySelectorAll('*').forEach(function(el) {
        if (el.children.length === 0 && (el.textContent || '').trim() === 'Recipients') recipientsDefault = el;
      });
      if (!recipientsDefault) return 'no Recipients element';
      recipientsDefault.click();
      return 'opened';
    })()
  `);
  if (recipientsOpen !== "opened") {
    return { status: "error", detail: `Recipients dropdown: ${recipientsOpen}` };
  }
  await page.waitForTimeout(1_500);

  const selectedRoles: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var visibleMenu = null;
      panel.querySelectorAll('.menu').forEach(function(el) {
        if (el.offsetParent !== null) visibleMenu = visibleMenu || el;
      });
      if (!visibleMenu) return JSON.stringify([]);
      var wanted = ${JSON.stringify(wantedRoles)}.map(function(w) { return w.toLowerCase(); });
      var clicked = [];
      var seen = {};
      Array.from(visibleMenu.children).forEach(function(item) {
        var t = (item.textContent || '').replace(/\\s+/g, ' ').trim();
        var tLower = t.toLowerCase();
        for (var i = 0; i < wanted.length; i++) {
          if (tLower.indexOf(wanted[i]) !== -1 && !seen[t]) { item.click(); clicked.push(t); seen[t] = true; break; }
        }
      });
      return JSON.stringify(clicked);
    })()
  `);
  const recipients: string[] = JSON.parse(selectedRoles);
  if (recipients.length === 0) {
    return { status: "error", detail: `No recipient matched roles [${wantedRoles.join(", ")}]` };
  }
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const viaFirstTry: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var all = panel.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
        if (txt === 'email with attachments' && el.offsetParent !== null) { el.click(); return 'clicked'; }
      }
      for (var j = 0; j < all.length; j++) {
        var el2 = all[j];
        var txt2 = el2.children.length === 0 ? (el2.textContent || '').trim() : '';
        if (txt2.indexOf('email using secure document portal') !== -1 && el2.offsetParent !== null) { el2.click(); return 'opened trigger'; }
      }
      return 'not found';
    })()
  `);
  if (viaFirstTry === "opened trigger") {
    await page.waitForTimeout(800);
    const viaRetry: string = await page.evaluate(`
      (function() {
        var panel = document.querySelector('sendemailpopup');
        var all = panel.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
          if (txt === 'email with attachments' && el.offsetParent !== null) { el.click(); return 'clicked'; }
        }
        return 'not found';
      })()
    `);
    if (viaRetry !== "clicked") {
      return { status: "error", recipients, detail: `"email with attachments" option: ${viaRetry}` };
    }
  } else if (viaFirstTry !== "clicked") {
    return { status: "error", recipients, detail: `"via" dropdown: ${viaFirstTry}` };
  }
  await page.waitForTimeout(1_000);

  const wantedFullPolicyNames = policies.map((p) => FULL_POLICY_NAMES[p]);
  const attachResultRaw: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var scrolling = panel.querySelector('.scrolling.menu');
      if (!scrolling) return JSON.stringify({ error: 'no attachment picker found' });
      var wantedFolder = ${JSON.stringify(RECORDED_DOCUMENTS_FOLDER)};
      var wantedNames = ${JSON.stringify(wantedFullPolicyNames)};
      var clicked = [];
      Array.from(scrolling.children).forEach(function(item) {
        var t = (item.textContent || '').replace(/\\s+/g, ' ').trim();
        var isRecorded = t.slice(-wantedFolder.length) === wantedFolder;
        var isFullPolicy = wantedNames.some(function(n) { return t.indexOf(n) === 0; });
        if (isRecorded || isFullPolicy) { item.click(); clicked.push(t); }
      });
      return JSON.stringify(clicked);
    })()
  `);
  let attachments: string[];
  try {
    attachments = JSON.parse(attachResultRaw);
    if (!Array.isArray(attachments)) throw new Error("not an array");
  } catch {
    return { status: "error", recipients, detail: `Attachment picker failed: ${attachResultRaw}` };
  }
  if (attachments.length === 0) {
    return { status: "error", recipients, detail: "No attachments matched (expected Recorded documents + Full Policy files)." };
  }

  if (opts.composeOnly) {
    return { status: "sent", recipients, attachments, detail: "[composeOnly] nothing actually sent" };
  }

  const sendResult: string = await page.evaluate(`
    (function() {
      var panel = document.querySelector('sendemailpopup');
      var all = panel.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
        if (txt === 'Send' && el.offsetParent !== null) { el.click(); return 'clicked'; }
      }
      return 'not found';
    })()
  `);
  if (sendResult !== "clicked") {
    return { status: "error", recipients, attachments, detail: `"Send" button: ${sendResult}` };
  }
  await page.waitForTimeout(3_000);

  return { status: "sent", recipients, attachments };
}
