import type { Page } from "playwright-core";
import { google } from "googleapis";
import { withSession } from "../../browserbase";
import { navigateToOrder } from "../../utils/navigate";
import { uploadDocument } from "../../actions/upload-document";
import { archiveEmail } from "../../gmail";
import { dismissStartupModals } from "../../utils/dismiss-modals";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dotenv from "dotenv";
dotenv.config();

const EMAIL_ID = "19e6ad54b4f9bb36";
const ORDER_INTERNAL_ID = "TWu7SuTsQcLrg7Q59";
const NEW_CLOSING_DATE = "05/28/2026";

async function fetchAttachments(messageId: string): Promise<string[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  const gmail = google.gmail({ version: "v1", auth });
  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const dir = join(tmpdir(), `qualia-email-${messageId}`);
  mkdirSync(dir, { recursive: true });
  const filePaths: string[] = [];
  async function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId });
      const dest = join(dir, part.filename);
      writeFileSync(dest, Buffer.from(res.data.data ?? "", "base64url"));
      filePaths.push(dest);
    }
    for (const p of part.parts ?? []) await walk(p);
  }
  await walk(full.data.payload);
  return filePaths;
}

async function updateClosingDate(page: Page, orderId: string, newDate: string): Promise<void> {
  await navigateToOrder(page, orderId, "basic");
  await dismissStartupModals(page);

  // Find the ESTIMATED CLOSING DATE input inside the dates-two-column container
  const closingInput = page
    .locator(".fields.dates-two-column")
    .locator(".field", { hasText: "ESTIMATED CLOSING DATE" })
    .locator("input")
    .first();

  await closingInput.waitFor({ state: "visible", timeout: 10_000 });

  // Triple-click to select all existing text, then fill
  await closingInput.click({ clickCount: 3 });
  await closingInput.fill(newDate);
  await closingInput.press("Tab");

  // Give React time to process the change, then save
  await page.waitForTimeout(800);

  // Look for a Save button in or near the form
  const saveBtn = page.locator("#basicInfoForm button", { hasText: "Save" }).first();
  const saveBtnVisible = await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (saveBtnVisible) {
    await saveBtn.click();
    await page.waitForTimeout(1_000);
    console.log("  ✓ Clicked Save button");
  } else {
    // Try a general Save button on the page
    const anyBtn = page.getByRole("button", { name: "Save" }).first();
    const anyVisible = await anyBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (anyVisible) {
      await anyBtn.click();
      await page.waitForTimeout(1_000);
      console.log("  ✓ Clicked Save button");
    } else {
      console.log("  (no Save button found — change may auto-save on blur)");
    }
  }
}

async function main() {
  console.log("Fetching attachment from Gmail...");
  const filePaths = await fetchAttachments(EMAIL_ID);
  console.log(`  Files: ${filePaths.map((f) => f.split("/").pop()).join(", ")}`);

  await withSession(async (page) => {
    // 1. Update closing date on the basic info page
    console.log("\nUpdating closing date to", NEW_CLOSING_DATE, "...");
    await updateClosingDate(page, ORDER_INTERNAL_ID, NEW_CLOSING_DATE);
    console.log("  ✓ Closing date updated");

    // 2. Upload the document
    console.log("\nUploading document...");
    for (const filePath of filePaths) {
      await uploadDocument(page, ORDER_INTERNAL_ID, filePath);
      console.log(`  ✓ ${filePath.split("/").pop()}`);
    }
  });

  // 3. Archive the email
  await archiveEmail(EMAIL_ID);
  console.log("\n✓ Email archived");
  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
