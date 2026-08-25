import type { Page } from "playwright-core";
import { navigateToOrder } from "../utils/navigate";
import { dismissStartupModals } from "../utils/dismiss-modals";

export interface RecordingCheckResult {
  recorded: boolean;
  documents: { name: string; recordedDate: string | null }[];
}

/**
 * Check the order's Recording > Recorded Documents tab. `recorded` is true
 * only when every listed document has a non-empty Recorded Date -- Simplifile
 * sometimes records a package's documents in separate batches, so an order
 * can have some rows populated and others still blank.
 *
 * First-pass selectors based on screenshots, not a live session -- verify
 * against the real DOM (same inspection pattern as this repo's debug-*.ts
 * scripts) before relying on this against production orders.
 */
export async function verifyRecording(page: Page, orderId: string): Promise<RecordingCheckResult> {
  await navigateToOrder(page, orderId, "recording");
  await dismissStartupModals(page);
  // Wait for the table to actually render rather than a flat timeout -- a
  // fresh login + first navigation can take noticeably longer than a warm
  // session (see prepare-final-policy.ts's checkIfUnchecked comment).
  await page.locator("table tbody tr").first().waitFor({ state: "attached", timeout: 45_000 }).catch(() => {});

  const rows = page.locator("table tbody tr");
  const count = await rows.count();
  const documents: { name: string; recordedDate: string | null }[] = [];

  for (let i = 0; i < count; i++) {
    const cells = rows.nth(i).locator("td");
    const name = ((await cells.nth(0).innerText().catch(() => "")) || "").trim();
    const recordedDateRaw = ((await cells.nth(1).innerText().catch(() => "")) || "").trim();
    if (!name) continue;
    documents.push({ name, recordedDate: recordedDateRaw || null });
  }

  const recorded = documents.length > 0 && documents.every((d) => !!d.recordedDate);
  return { recorded, documents };
}
