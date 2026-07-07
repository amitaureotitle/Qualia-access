import type { Page } from "playwright-core";

/**
 * Dismiss any startup modals Qualia shows at the beginning of a session.
 * Safe to call on every page load — skips silently if no modal is present.
 */
export async function dismissStartupModals(page: Page): Promise<void> {
  // Timezone detection modal — always keep Israel time, suppress future prompts
  const timezoneModal = page.locator('text=Different Timezone Detected');
  if (await timezoneModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const checkboxLabel = page.locator('.ui.dimmer.modals.active .ui.checkbox label');
    if (await checkboxLabel.isVisible().catch(() => false)) {
      await checkboxLabel.click();
    }
    await page.locator('text=No, keep time zone').click();
    await timezoneModal.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }

  // Amplitude "What's New" engagement popup — wait for it to appear, then remove via JS
  // (It loads asynchronously after domcontentloaded, so we poll briefly)
  const engagementModal = page.locator('.amplitude-engagement-modal-container');
  const appeared = await engagementModal.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (appeared) {
    // Force-remove from DOM — more reliable than clicking through animations
    await page.evaluate(`
      (function() {
        var wrapper = document.getElementById("engagement-wrapper");
        if (wrapper) wrapper.remove();
        document.querySelectorAll(".amplitude-engagement-modal-container, .rc-dialog-wrap").forEach(function(el) { el.remove(); });
      })()
    `);
  }
}
