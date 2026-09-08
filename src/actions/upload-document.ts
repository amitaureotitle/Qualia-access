import { readFileSync } from "fs";
import { basename } from "path";
import type { Page } from "playwright-core";
import { dismissStartupModals } from "../utils/dismiss-modals";

export interface UploadOptions {
  /** Override the document name shown in Qualia (leave blank to keep the filename) */
  name?: string;
}

/**
 * Upload a local file to the Documents section of a Qualia order.
 * @param orderId  Internal Qualia URL ID (e.g. "vAEFGRHqzxxkTzMYe")
 * @param filePath Absolute path to the local file to upload
 */
export async function uploadDocument(
  page: Page,
  orderId: string,
  filePath: string,
  options: UploadOptions = {}
): Promise<void> {
  await page.goto(
    `https://aureotitle.qualia.io/orders/${orderId}/documents`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await dismissStartupModals(page);
  await page.waitForTimeout(3000);

  // Click the "Upload" link/button to open the upload dialog. Search in
  // reverse DOM order and take the LAST visible match, not the first — the
  // toolbar tab that opens the dialog and the dialog's own trigger can both
  // have this exact text, and a freshly-opened dialog is reliably appended
  // later in the DOM than the static toolbar above it.
  await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = all.length - 1; i >= 0; i--) {
        var txt = (all[i].textContent || '').trim();
        if (txt === 'Upload' && all[i].offsetParent !== null) {
          all[i].click();
          return;
        }
      }
    })()
  `);
  await page.waitForTimeout(1000);

  // Set the file — pass as buffer so remote Playwright can access it regardless of path resolution
  await page.setInputFiles('input[type="file"]', {
    name: basename(filePath),
    mimeType: filePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    buffer: readFileSync(filePath),
  });
  await page.waitForTimeout(1500);

  // Optionally fill document name
  if (options.name) {
    await page.evaluate(`
      (function() {
        var inputs = document.querySelectorAll('input[type="text"], input[placeholder]');
        for (var i = 0; i < inputs.length; i++) {
          var ph = (inputs[i].placeholder || '').toLowerCase();
          if (ph.includes('name') || ph.includes('title') || ph.includes('document')) {
            inputs[i].value = ${JSON.stringify(options.name)};
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      })()
    `);
    await page.waitForTimeout(500);
  }

  // Click Save / Upload / Submit -- same reverse-order reasoning as the
  // trigger click above: the confirm button lives in the dialog, appended
  // after the toolbar that may still be visible behind it.
  const clickedConfirm = await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = all.length - 1; i >= 0; i--) {
        var txt = (all[i].textContent || '').trim();
        if ((txt === 'Save' || txt === 'Upload' || txt === 'Submit') && all[i].offsetParent !== null) {
          all[i].click();
          return true;
        }
      }
      return false;
    })()
  `);
  if (!clickedConfirm) {
    throw new Error("uploadDocument: could not find a visible Save/Upload/Submit control to confirm the upload");
  }

  // Verify the upload actually went through rather than assuming success
  // after a fixed wait: the file input we just populated should detach (the
  // dialog closing/re-rendering) once Qualia accepts the upload. If it's
  // still there after a generous timeout, something didn't confirm.
  try {
    await page.waitForSelector('input[type="file"]', { state: "detached", timeout: 10_000 });
  } catch {
    throw new Error("uploadDocument: upload dialog did not close after confirming -- the upload may not have completed");
  }
}
