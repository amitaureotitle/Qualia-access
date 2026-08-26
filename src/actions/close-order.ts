import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";

export interface CloseOrderResult {
  status: "closed" | "error";
  detail?: string;
}

/**
 * Confirmed live 2026-08-26 against order 2026-MO-300. The status control
 * on dashboard/summary is a custom <changestatus> dropdown (class "ui
 * subtle positive floating dropdown button"); its options (including a
 * <closeorder> item for "Closed") only become visible/interactive once the
 * dropdown is opened by clicking its own <div class="text"> trigger
 * (showing the current status, e.g. "Open") -- clicking <closeorder>
 * directly while the dropdown is still closed silently no-ops (confirmed:
 * the click "succeeded" with no error, but status stayed "Open" on
 * verification). Same two-step open-then-select pattern as the "via"
 * send-type dropdown in send-trailing-documents.ts.
 *
 * Clicking <closeorder> then opens a second confirmation modal
 * (<globalmodal id="changeOrderStatusModal">, "Close This Order -- Closing
 * an order will mark it as completed. Are you sure you want to do this?"),
 * also not caught by the first fix's verification (status still read
 * "Open" with the modal sitting there unconfirmed). Confirm button is
 * <confirmorderstatuschange> ("Close Order"); cancel is
 * <cancelorderstatuschange> ("Keep Order") -- NOT a <yes> element like
 * process-one-order.ts's importXmlToQualia confirm dialog, that guess was
 * wrong for this specific modal.
 */
export async function closeOrder(page: Page, orderId: string): Promise<CloseOrderResult> {
  await navigateToOrder(page, orderId, "dashboard/summary");
  await dismissStartupModals(page);
  await page.locator("changestatus").first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1_000);

  const openResult: string = await page.evaluate(`
    (function() {
      var trigger = document.querySelector('changestatus .text');
      if (!trigger) return 'no status trigger found';
      trigger.click();
      return 'opened';
    })()
  `);
  if (openResult !== "opened") {
    return { status: "error", detail: `Status dropdown: ${openResult}` };
  }
  await page.waitForTimeout(1_000);

  const closeResult: string = await page.evaluate(`
    (function() {
      var btn = document.querySelector('closeorder');
      if (!btn) return 'not found';
      if (btn.offsetParent === null) return 'not visible after opening dropdown';
      if (btn.classList.contains('disabled')) return 'disabled';
      btn.click();
      return 'clicked';
    })()
  `);
  if (closeResult !== "clicked") {
    return { status: "error", detail: `"Closed" status option ${closeResult}.` };
  }
  await page.waitForTimeout(1_000);

  const confirmResult: string = await page.evaluate(`
    (function() {
      var modal = null;
      document.querySelectorAll('.ui.modal').forEach(function(el) {
        if (el.offsetParent !== null && (el.textContent || '').indexOf('Close This Order') !== -1) modal = el;
      });
      if (!modal) return 'no confirmation modal found';
      var confirmBtn = modal.querySelector('confirmorderstatuschange');
      if (!confirmBtn) return 'no confirmorderstatuschange element found';
      confirmBtn.click();
      return 'confirmed';
    })()
  `);
  if (confirmResult !== "confirmed") {
    return { status: "error", detail: `Confirmation modal: ${confirmResult}` };
  }
  await page.waitForTimeout(2_000);

  // Verify -- don't just trust the click, confirmed necessary by this
  // exact bug (the pre-fix version reported "clicked" with status still Open).
  const verify: string = await page.evaluate(`
    (function() {
      var found = [];
      document.querySelectorAll('changestatus .text, changestatus div.text').forEach(function(el) {
        var t = (el.textContent || '').trim();
        if (t) found.push(t);
      });
      return JSON.stringify(found);
    })()
  `);
  let statusTexts: string[] = [];
  try {
    statusTexts = JSON.parse(verify);
  } catch {
    // fall through, treat as unverified but not necessarily failed
  }
  if (statusTexts.length > 0 && !statusTexts.some((t) => t === "Closed")) {
    return { status: "error", detail: `Clicked "Closed" but status still reads: ${statusTexts.join(", ")}` };
  }

  return { status: "closed" };
}
