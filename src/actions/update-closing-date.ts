import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";

/**
 * Update the Estimated Closing Date field on a Qualia order's Basic Info page.
 * @param orderId  Internal Qualia URL ID (e.g. "TWu7SuTsQcLrg7Q59")
 * @param newDate  Date string in MM/DD/YYYY format
 */
export async function updateClosingDate(page: Page, orderId: string, newDate: string): Promise<void> {
  await navigateToOrder(page, orderId, "basic");
  await dismissStartupModals(page);

  const closingInput = page
    .locator(".fields.dates-two-column")
    .locator(".field", { hasText: "ESTIMATED CLOSING DATE" })
    .locator("input")
    .first();

  await closingInput.waitFor({ state: "visible", timeout: 10_000 });
  await closingInput.click({ clickCount: 3 });
  await closingInput.fill(newDate);
  await closingInput.press("Tab");
  await page.waitForTimeout(800);

  // Click Save if a button is present (some forms auto-save on blur)
  const saveBtn = page.getByRole("button", { name: "Save" }).first();
  if (await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(1_000);
  }
}
