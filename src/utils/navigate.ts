import type { Page } from "playwright-core";
import { dismissStartupModals } from "./dismiss-modals";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

export function orderUrl(orderId: string, section = "dashboard") {
  return new URL(`/orders/${orderId}/${section}`, BASE_URL).href;
}

export interface OrderSearchResult {
  /** Human-readable order number, e.g. "2026-MO-175" */
  orderNumber: string;
  /** Full display text from the search dropdown */
  label: string;
}

/**
 * Resolve a human-readable order number (e.g. "2026-MO-131") to the internal URL ID.
 * Searches, clicks the matching result, and extracts the ID from the resulting URL.
 */
export async function resolveOrderId(page: Page, orderNumber: string): Promise<string> {
  await page.goto(new URL("/home/orders", BASE_URL).href, { waitUntil: "domcontentloaded" });
  await dismissStartupModals(page);

  const searchBox = page.getByPlaceholder("Find order...");
  await searchBox.click();
  await searchBox.fill(orderNumber);

  await page.waitForSelector(".results.transition.visible", { timeout: 10_000 });

  // Click the result that contains the exact order number
  const result = page.locator(`.results.transition.visible .result`, {
    hasText: orderNumber,
  }).first();
  await result.click();

  await page.waitForURL(/\/orders\/[^/]+\//, { timeout: 10_000 });

  const parts = new URL(page.url()).pathname.split("/");
  const id = parts[2];
  if (!id) throw new Error(`Could not extract order ID from URL: ${page.url()}`);
  return id;
}

/**
 * Search the "Find order..." bar and return ALL matching results.
 * Results include the human-readable order number extracted from the dropdown text.
 */
export async function searchOrders(page: Page, query: string): Promise<OrderSearchResult[]> {
  await page.goto(new URL("/home/orders", BASE_URL).href, { waitUntil: "domcontentloaded" });
  await dismissStartupModals(page);

  const searchBox = page.getByPlaceholder("Find order...");
  await searchBox.click();
  await searchBox.fill(query);

  // Wait for dropdown results to appear
  await page.waitForSelector(".results.transition.visible", { timeout: 10_000 });

  // <a class="result"> elements have no href — navigation is JS-driven.
  // Extract the order number (e.g. "2026-MO-175") from the text content.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = await page.$$eval(".results.transition.visible .result", (els: any[]) =>
    els.map((el: any) => {
      // innerText has 3 lines: address, "Order XXXX", address (repeated)
      const lines: string[] = (el.innerText ?? "")
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);
      const orderLine = lines.find((l: string) => /^Order \d{4}-[A-Z]+-\d+$/.test(l)) ?? "";
      const orderNumber: string = orderLine.replace("Order ", "");
      // Prefer lines that look like street addresses (contain a digit and a comma)
      const addressLine =
        lines.find((l: string) => !l.startsWith("Order ") && /\d/.test(l) && l.includes(",")) ??
        lines.find((l: string) => !l.startsWith("Order ")) ??
        lines[0] ?? "";
      const label = orderNumber ? `${orderNumber} — ${addressLine}` : lines.join(" ");
      return { orderNumber, label };
    })
  );

  return results.filter((r) => r.orderNumber.length > 0);
}

export async function navigateToOrder(page: Page, orderId: string, section = "dashboard") {
  await page.goto(orderUrl(orderId, section), { waitUntil: "domcontentloaded" });
}
