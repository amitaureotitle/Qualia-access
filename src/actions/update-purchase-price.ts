import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";

/**
 * Update the Purchase Price field on a Qualia order's Basic Info page.
 * @param orderId  Internal Qualia URL ID
 * @param amount   Numeric string, e.g. "42500" or "245000"
 */
export async function updatePurchasePrice(page: Page, orderId: string, amount: string): Promise<void> {
  await navigateToOrder(page, orderId, "basic");
  await dismissStartupModals(page);

  const priceInput = page
    .locator(".field", { hasText: /purchase price/i })
    .locator("input")
    .first();

  await priceInput.waitFor({ state: "visible", timeout: 10_000 });
  await priceInput.click({ clickCount: 3 });
  await priceInput.fill(amount);
  await priceInput.press("Tab");
  await page.waitForTimeout(800);

  const saveBtn = page.getByRole("button", { name: "Save" }).first();
  if (await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(1_000);
  }
}
