import type { Page } from "playwright-core";
import { dismissStartupModals } from "../utils/dismiss-modals";

export interface MatchEmdWireResult {
  status: "matched" | "error";
  matchedText?: string;
  detail?: string;
}

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";
// Confirmed live 2026-08-27: this is the Axos Trust Account's own stable
// Qualia ID (its <swapbank data-value="..."> in the account-switcher
// dropdown), not a per-session token -- safe to hardcode with an env
// override, unlike an order's URL ID which navigateToOrder resolves fresh
// every time.
const TRUST_ACCOUNT_ID = process.env.QUALIA_TRUST_ACCOUNT_ID || "TgTSZFSEsWr388MbF";

function incomingWiresUrl() {
  return new URL(`/accounting/${TRUST_ACCOUNT_ID}/incoming_wires`, BASE_URL).href;
}

/**
 * Confirmed live 2026-08-27 against a real pending Zoom EMD wire (order
 * 2026-MO-328, FedWire 20260825MMQFMP22000316, address "1713 Partridge
 * Drive, Imperial, MO"):
 * - Pending wires are a real <table> (unlike most of this app's custom
 *   Semantic-UI elements) -- one <tr> per wire, its "Match" <a> in the last
 *   cell, wire text (including the FedWire #) in the row's textContent.
 * - Clicking "Match" opens a <globalmodal class="... active">, defaulting
 *   to the "Send To Order" tab already selected (an <input name="resolve_type">
 *   with value "send_to_order") -- no need to click the tab ourselves.
 * - Order lookup is a live-search input (placeholder "Search orders...";
 *   its `name` attribute is a random per-render string, don't rely on it).
 *   Typing the full order number produced exactly one dropdown result
 *   (text like "2026-MO-3281713 Partridge Drive, Imperial, MO" -- order
 *   number and address concatenated with no separator); clicking it
 *   populates "Enter Order Criteria" with the resolved address/seller --
 *   this is the safety cross-check read back before ever submitting.
 * - Real submit is a custom <finish class="ui primary button"> inside
 *   div.actions -- NOT the "Send To Order" *tab* button (same text, an
 *   <a class="ui active button"> inside div.ui.compact.buttons; clicking
 *   that would just re-select an already-active tab, a no-op).
 * - "Funds For Benefit Of" (an <afdropdowninput> field, identified reliably
 *   by its hidden input's `data-schema-key="for_benefit_of"` -- its `name`
 *   is a random per-render string like the order-search input) **defaults
 *   to "Buyer"** (`data-value="borrower"`), not "None". The human workflow
 *   this replaces always sets it to "None" before submitting (confirmed by
 *   the user 2026-08-27, after the very first live --live run posted a real
 *   transaction with "For Benefit Of: Borrower" left at the default -- not
 *   yet corrected in Qualia as of this writing, see AUTOMATIONS.md). This
 *   action now explicitly opens that dropdown and clicks its
 *   `.item[data-value="none"]` option, verified against the hidden input's
 *   value afterward -- never trust the click alone.
 *
 * NOT yet independently live-verified past the FBO fix: the "Funds For
 * Benefit Of" correction has only been dry-run (composeOnly), never
 * followed all the way through a real --live submit. Always dry-run with
 * composeOnly: true first and inspect matchedText before ever calling with
 * composeOnly: false -- this creates a real transaction matching real
 * escrow money to a real order, irreversible via this action.
 */
export async function matchEmdWire(
  page: Page,
  orderNumber: string,
  fedwireNumber: string,
  expectedAddress: string,
  opts: { composeOnly?: boolean } = {}
): Promise<MatchEmdWireResult> {
  await page.goto(incomingWiresUrl(), { waitUntil: "domcontentloaded" });
  await dismissStartupModals(page);
  await page.waitForTimeout(2_000);

  const clickResult: string = await page.evaluate(`
    (function() {
      var rows = document.querySelectorAll('table tr');
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        if ((tr.textContent || '').indexOf(${JSON.stringify(fedwireNumber)}) === -1) continue;
        var links = tr.querySelectorAll('a');
        for (var j = 0; j < links.length; j++) {
          if ((links[j].textContent || '').trim() === 'Match') { links[j].click(); return 'clicked'; }
        }
        return 'row found, no Match link';
      }
      return 'not found in pending wires';
    })()
  `);
  if (clickResult !== "clicked") {
    return { status: "error", detail: `Pending wire ${fedwireNumber}: ${clickResult}` };
  }

  await page.locator("globalmodal.active").first().waitFor({ state: "attached", timeout: 15_000 });
  await page.waitForTimeout(1_000);

  const searchInput = page.locator('globalmodal.active input[placeholder="Search orders..."]').first();
  await searchInput.fill(orderNumber);
  await page.waitForTimeout(2_000);

  const pickResult: string = await page.evaluate(`
    (function() {
      var modal = document.querySelector('globalmodal.active');
      var items = modal.querySelectorAll('.results .result, .menu .item');
      for (var i = 0; i < items.length; i++) {
        var t = items[i].textContent || '';
        if (t.indexOf(${JSON.stringify(orderNumber)}) !== -1) { items[i].click(); return 'clicked'; }
      }
      return 'no matching order in dropdown';
    })()
  `);
  if (pickResult !== "clicked") {
    return { status: "error", detail: `Order ${orderNumber} lookup: ${pickResult}` };
  }
  await page.waitForTimeout(1_500);

  // Safety cross-check: read back the resolved "Enter Order Criteria"
  // section and confirm the address Qualia resolved for this order number
  // actually matches the address we expected -- refuse to submit on a
  // mismatch rather than trust the order-number string alone.
  const criteriaText: string = await page.evaluate(`
    (function() {
      var modal = document.querySelector('globalmodal.active');
      var text = (modal.textContent || '').replace(/\\s+/g, ' ').trim();
      var idx = text.indexOf('Enter Order Criteria');
      var wireIdx = text.indexOf('Wire Information');
      if (idx === -1) return '';
      return text.slice(idx, wireIdx === -1 ? idx + 500 : wireIdx);
    })()
  `);

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!expectedAddress || !normalize(criteriaText).includes(normalize(expectedAddress))) {
    return {
      status: "error",
      matchedText: criteriaText,
      detail: `Resolved order criteria doesn't contain expected address "${expectedAddress}" -- refusing to submit`,
    };
  }

  // "Funds For Benefit Of" defaults to "Buyer" -- must be explicitly
  // switched to "None" (see doc comment above). Find its container by the
  // stable data-schema-key, not the random input name.
  const openFboResult: string = await page.evaluate(`
    (function() {
      var containers = document.querySelectorAll('afdropdowninput');
      for (var i = 0; i < containers.length; i++) {
        if (!containers[i].querySelector('input[data-schema-key="for_benefit_of"]')) continue;
        var trigger = containers[i].querySelector('.text');
        if (!trigger) return 'no dropdown trigger found';
        trigger.click();
        return 'opened';
      }
      return 'no for_benefit_of field found';
    })()
  `);
  if (openFboResult !== "opened") {
    return { status: "error", matchedText: criteriaText, detail: `Funds For Benefit Of dropdown: ${openFboResult}` };
  }
  await page.waitForTimeout(800);

  const pickNoneResult: string = await page.evaluate(`
    (function() {
      var containers = document.querySelectorAll('afdropdowninput');
      for (var i = 0; i < containers.length; i++) {
        if (!containers[i].querySelector('input[data-schema-key="for_benefit_of"]')) continue;
        var item = containers[i].querySelector('.item[data-value="none"]');
        if (!item) return 'no None option found';
        item.click();
        return 'clicked';
      }
      return 'no for_benefit_of field found';
    })()
  `);
  if (pickNoneResult !== "clicked") {
    return { status: "error", matchedText: criteriaText, detail: `Funds For Benefit Of "None" option: ${pickNoneResult}` };
  }
  await page.waitForTimeout(500);

  // Verify -- don't just trust the click (same discipline as close-order.ts).
  const fboValue: string = await page.evaluate(`
    (function() {
      var input = document.querySelector('afdropdowninput input[data-schema-key="for_benefit_of"]');
      return input ? input.value : 'no input found';
    })()
  `);
  if (fboValue !== "none") {
    return {
      status: "error",
      matchedText: criteriaText,
      detail: `Funds For Benefit Of still reads "${fboValue}" after clicking None -- refusing to submit`,
    };
  }

  if (opts.composeOnly) {
    return { status: "matched", matchedText: criteriaText, detail: "[composeOnly] nothing actually sent" };
  }

  const finishResult: string = await page.evaluate(`
    (function() {
      var modal = document.querySelector('globalmodal.active');
      var btn = modal.querySelector('finish');
      if (!btn) return 'no finish element found';
      if (btn.classList.contains('disabled')) return 'disabled';
      btn.click();
      return 'clicked';
    })()
  `);
  if (finishResult !== "clicked") {
    return { status: "error", matchedText: criteriaText, detail: `Send To Order submit: ${finishResult}` };
  }
  await page.waitForTimeout(2_000);

  return { status: "matched", matchedText: criteriaText };
}
