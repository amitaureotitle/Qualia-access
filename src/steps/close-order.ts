import { Driver, clickFound, openOrder } from "./driver";

export interface CloseOrderResult {
  status: "closed" | "rehearsed" | "error";
  detail?: string;
  /** base64 PNG of the order page once it reads Closed -- posted to Slack with the run report. */
  screenshot?: string;
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
 * send-type dropdown in send-message.ts.
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
 *
 * Moved here from actions/close-order.ts 2026-10-19 (driver-based so the
 * Closeout Tester extension runs the same code); behaviour unchanged except
 * that the irreversible part is now the modal's confirm click, gated by
 * commit() -- opening the dropdown and choosing "Closed" alone changes
 * nothing until "Close Order" is confirmed.
 */
export async function closeOrderStep(d: Driver, orderId: string, opts: { rehearse?: boolean } = {}): Promise<CloseOrderResult> {
  await openOrder(d, orderId, "dashboard/summary");
  await d.waitFor(`!!document.querySelector('changestatus')`, 30_000);
  await d.sleep(1_000);

  d.note("Opening the status dropdown");
  const openResult = await clickFound(
    d,
    `document.querySelector('changestatus .text') || 'no status trigger found'`,
    "Open the status dropdown"
  );
  if (openResult !== "clicked") {
    return { status: "error", detail: `Status dropdown: ${openResult}` };
  }
  await d.sleep(1_000);

  d.note('Choosing "Closed"');
  const closeResult = await clickFound(
    d,
    `(function() {
      var btn = document.querySelector('closeorder');
      if (!btn) return null;
      if (btn.offsetParent === null) return 'not visible after opening dropdown';
      if (btn.classList.contains('disabled')) return 'disabled';
      return btn;
    })()`,
    'Choose "Closed"'
  );
  if (closeResult !== "clicked") {
    return { status: "error", detail: `"Closed" status option ${closeResult}.` };
  }
  await d.sleep(1_000);

  if (opts.rehearse) {
    // Dry run: everything up to the confirmation, then back out -- choosing
    // "Closed" only opens the modal; nothing changes until "Close Order".
    const shown = await d.evaluate<string>(`
      (function() {
        var modal = null;
        document.querySelectorAll('.ui.modal').forEach(function(el) {
          if (el.offsetParent !== null && (el.textContent || '').indexOf('Close This Order') !== -1) modal = el;
        });
        if (!modal) return 'no confirmation modal found';
        var btn = modal.querySelector('confirmorderstatuschange');
        if (!btn) return 'no confirmorderstatuschange element found';
        btn.setAttribute('data-wf-target', 'close-confirm');
        return 'ok';
      })()
    `);
    if (shown !== "ok") return { status: "error", detail: `Confirmation modal: ${shown}` };
    await d.show(`[data-wf-target="close-confirm"]`, 'Would click "Close Order" (dry run)');
    const cancel = await clickFound(
      d,
      `(function() {
        var modal = null;
        document.querySelectorAll('.ui.modal').forEach(function(el) {
          if (el.offsetParent !== null && (el.textContent || '').indexOf('Close This Order') !== -1) modal = el;
        });
        return modal ? (modal.querySelector('cancelorderstatuschange') || 'no Keep Order button') : 'no confirmation modal found';
      })()`,
      'Click "Keep Order" (dry run -- backing out)'
    );
    if (cancel !== "clicked") {
      return { status: "error", detail: `Dry run couldn't back out with "Keep Order": ${cancel} -- the confirmation is still open, nothing was changed` };
    }
    await d.sleep(1_500);
    const still = await d.evaluate<string>(`((document.querySelector('changestatus .text') || {}).textContent || '').trim()`);
    if (still === "Closed") return { status: "error", detail: "Dry run: status reads Closed after Keep Order -- check the order" };
    return { status: "rehearsed", detail: `Dry run: "Close Order" not clicked; status still ${still || "unchanged"}` };
  }

  await d.commit('Confirm "Close Order"');
  d.note('Confirming "Close Order"');
  const confirmResult = await clickFound(
    d,
    `(function() {
      var modal = null;
      document.querySelectorAll('.ui.modal').forEach(function(el) {
        if (el.offsetParent !== null && (el.textContent || '').indexOf('Close This Order') !== -1) modal = el;
      });
      if (!modal) return 'no confirmation modal found';
      return modal.querySelector('confirmorderstatuschange') || 'no confirmorderstatuschange element found';
    })()`,
    'Click "Close Order"'
  );
  if (confirmResult !== "clicked") {
    return { status: "error", detail: `Confirmation modal: ${confirmResult}` };
  }
  await d.sleep(2_000);

  // Verify -- don't just trust the click, confirmed necessary by this
  // exact bug (the pre-fix version reported "clicked" with status still Open).
  const verify = await d.evaluate<string>(`
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
    return { status: "error", detail: `Clicked "Close Order" but status still reads: ${statusTexts.join(", ")}` };
  }
  d.note("Order reads Closed -- taking a screenshot for the Slack report");
  await d.evaluate(`window.scrollTo(0, 0)`);
  const screenshot = await d.screenshot(":viewport").catch(() => undefined);
  return { status: "closed", screenshot };
}
