import type { Page } from "playwright-core";
import { dismissStartupModals } from "../utils/dismiss-modals";

/**
 * Fill an individual buyer's contact fields on Contacts → Buyers → <index>.
 *
 * The caller (Pipeline-dashboard's Order Assistant) decides WHICH fields to
 * send: only ones blank in Qualia, already checked through the GraphQL API.
 * This action just types them. It never clears a field, and it doesn't verify
 * -- the caller re-reads every field through the API afterwards, which is the
 * real success signal (a Qualia UI change shows up there as a mismatch, never
 * as silently wrong data).
 *
 * Fields are located by their visible labels: input ids on this page are
 * random per render, but labels ("FIRST NAME", "EMAIL", ...) are stable.
 * Info tab fields save on blur; a Save button is clicked if one appears.
 */
export interface BorrowerFields {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  marital_status?: string;   // Qualia option text, e.g. "Married", "Single", "Unmarried"
  ssn?: string;              // digits only
  dob?: string;              // MM/DD/YYYY
  email?: string;
  cell_phone?: string;       // digits only
  current_address?: { street: string; unit?: string; city?: string; state?: string; zip?: string };
}

export interface FillResult {
  status: "ok" | "partial" | "error";
  typed: string[];
  failed: { field: string; detail: string }[];
}

type TextField = Exclude<keyof BorrowerFields, "current_address" | "marital_status">;
const TEXT_LABELS: [TextField, string][] = [
  ["first_name", "first name"], ["middle_name", "middle name"], ["last_name", "last name"],
  ["ssn", "ssn"], ["dob", "date of birth"], ["email", "email"], ["cell_phone", "cell phone"],
];

const BASE = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

function field(page: Page, label: string) {
  const re = new RegExp(`^\\s*${label.replace(/ /g, "\\s+")}\\s*\\*?\\s*$`, "i");
  return page.locator(".field").filter({ has: page.locator("label").filter({ hasText: re }) }).first();
}

async function saveIfShown(page: Page) {
  const save = page.getByRole("button", { name: "Save" }).first();
  if (await save.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await save.click();
    await page.waitForTimeout(1_000);
  }
}

export async function fillBorrower(page: Page, orderId: string, index: number, fields: BorrowerFields): Promise<FillResult> {
  const typed: string[] = [];
  const failed: { field: string; detail: string }[] = [];

  await page.goto(new URL(`/orders/${orderId}/contacts/borrower/${index}`, BASE).href, { waitUntil: "domcontentloaded" });
  await dismissStartupModals(page);
  await page.locator("label").filter({ hasText: /first name/i }).first().waitFor({ timeout: 20_000 });

  for (const [key, label] of TEXT_LABELS) {
    const value = fields[key];
    if (!value) continue;
    try {
      const input = field(page, label).locator("input").first();
      await input.waitFor({ state: "visible", timeout: 8_000 });
      await input.click({ clickCount: 3 });
      await input.fill(value);
      await input.press("Tab");
      await page.waitForTimeout(600);
      typed.push(key);
    } catch (err) {
      failed.push({ field: key, detail: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }

  if (fields.marital_status) {
    try {
      const dropdown = field(page, "marital status").locator(".ui.dropdown").first();
      await dropdown.click();
      const option = dropdown.locator(".menu .item").filter({ hasText: new RegExp(`^\\s*${fields.marital_status}\\s*$`, "i") }).first();
      await option.click({ timeout: 5_000 });
      await page.waitForTimeout(600);
      typed.push("marital_status");
    } catch (err) {
      await page.keyboard.press("Escape").catch(() => undefined);
      failed.push({ field: "marital_status", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }
  await saveIfShown(page);

  if (fields.current_address) {
    // No autocomplete: Qualia's address search suggestions are unreliable to
    // target. Type the street into the Current ADDRESS box and leave it, then
    // fill City / Apt / Zipcode / State directly. Everything is scoped to the
    // first (Current) occurrence of each field; Forwarding is untouched.
    const a = fields.current_address;
    try {
      await page.getByText("Addresses", { exact: true }).first().click();
      const search = page.getByPlaceholder("Search address...").first();
      await search.waitFor({ state: "visible", timeout: 15_000 });
      await search.click();
      await search.fill(a.street);
      await page.keyboard.press("Escape");
      await search.press("Tab");
      await page.waitForTimeout(600);
      typed.push("address.street");
    } catch (err) {
      failed.push({ field: "address.street", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
    for (const [key, label] of [["unit", "apt, suite, etc\\."], ["city", "city"], ["zip", "zipcode"]] as const) {
      const value = a[key as "unit" | "city" | "zip"];
      if (!value) continue;
      try {
        const input = field(page, label).locator("input").first();
        await input.click({ clickCount: 3 });
        await input.fill(value);
        await input.press("Tab");
        await page.waitForTimeout(500);
        typed.push(`address.${key}`);
      } catch (err) {
        failed.push({ field: `address.${key}`, detail: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
    if (a.state) {
      try {
        const dropdown = field(page, "state").locator(".ui.dropdown").first();
        await dropdown.click();
        await page.waitForTimeout(400);
        // Options are 2-letter codes carried in data-value (e.g. data-value="MO").
        await dropdown.locator(`.menu .item[data-value="${a.state.toUpperCase()}"]`).first().click({ timeout: 5_000 });
        await page.waitForTimeout(500);
        typed.push("address.state");
      } catch (err) {
        await page.keyboard.press("Escape").catch(() => undefined);
        failed.push({ field: "address.state", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
    await saveIfShown(page);
  }

  return { status: failed.length === 0 ? "ok" : typed.length ? "partial" : "error", typed, failed };
}
