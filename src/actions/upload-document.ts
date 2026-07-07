import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
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
  await navigateToOrder(page, orderId, "documents");

  // Wait for the three-tab toolbar (Generate / Scan / Upload)
  await page.waitForSelector('[data-mode="upload"]', { timeout: 15_000 });

  // Dismiss startup modals (e.g. timezone detection)
  await dismissStartupModals(page);

  // Click the Upload tab
  await page.locator('[data-mode="upload"]').click();

  // Set the file directly on the hidden <input type="file">
  await page.locator('input[type="file"]').setInputFiles(filePath);

  // "Confirm Uploaded Document Names" dialog appears — optionally set a name
  await page.waitForSelector('text=Confirm Uploaded Document Names', { timeout: 15_000 });
  if (options.name) {
    const nameInput = page.locator('input[placeholder="Enter document name"]').first();
    await nameInput.fill(options.name);
  }

  // Save
  await page.getByText("Save", { exact: true }).click();

  // Wait for the dialog to close
  await page.waitForSelector('text=Confirm Uploaded Document Names', {
    state: "hidden",
    timeout: 15_000,
  });
}
