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

  // Click the "Upload" link/button to open the upload dialog
  await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
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

  // Click Save / Upload / Submit
  await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var txt = (all[i].textContent || '').trim();
        if ((txt === 'Save' || txt === 'Upload' || txt === 'Submit') && all[i].offsetParent !== null) {
          all[i].click();
          return;
        }
      }
    })()
  `);
  await page.waitForTimeout(4000);
}
