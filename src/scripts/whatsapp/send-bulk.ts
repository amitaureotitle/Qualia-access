/**
 * Send a personalized WhatsApp message to a list of phone numbers from a Google Sheet.
 *
 * Sheet format (default):
 *   Row 1: headers (skipped)
 *   Col A: phone number (E.164, e.g. +12025551234 or digits-only)
 *   Col B: message text
 *
 * Usage:
 *   npx ts-node src/scripts/whatsapp/send-bulk.ts [SPREADSHEET_ID]
 *
 * Env vars:
 *   WHATSAPP_SPREADSHEET_ID   — sheet ID (or pass as first CLI arg)
 *   WHATSAPP_SHEET_NAME       — tab name (default: Sheet1)
 *   WHATSAPP_PHONE_COLUMN     — column letter for phone (default: A)
 *   WHATSAPP_MESSAGE_COLUMN   — column letter for message (default: B)
 *   WHATSAPP_START_ROW        — first data row, 1-indexed (default: 2)
 *   WHATSAPP_DELAY_MS         — ms to wait between sends (default: 4000)
 *   GOOGLE_SERVICE_ACCOUNT_KEY_FILE
 *   GMAIL_USER
 */

import { google } from "googleapis";
import { writeFileSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { bb, createSession, connectToBrowser, releaseSession } from "../../browserbase";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVICE_ACCOUNT_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const GMAIL_USER = process.env.GMAIL_USER ?? "amit@aureotitle.com";
const SPREADSHEET_ID = process.argv[2] ?? process.env.WHATSAPP_SPREADSHEET_ID;
const SHEET_NAME = process.env.WHATSAPP_SHEET_NAME ?? "Sheet1";
const PHONE_COL = (process.env.WHATSAPP_PHONE_COLUMN ?? "A").toUpperCase();
const MSG_COL = (process.env.WHATSAPP_MESSAGE_COLUMN ?? "B").toUpperCase();
const START_ROW = parseInt(process.env.WHATSAPP_START_ROW ?? "2", 10);
const DELAY_MS = parseInt(process.env.WHATSAPP_DELAY_MS ?? "4000", 10);

if (!SERVICE_ACCOUNT_KEY_FILE) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required");
if (!SPREADSHEET_ID) throw new Error("Pass spreadsheet ID as first arg or set WHATSAPP_SPREADSHEET_ID");

// ─── Types ────────────────────────────────────────────────────────────────────

interface Row {
  phone: string;
  message: string;
}

type SendResult = { phone: string; status: "sent" | "skipped" | "error"; reason?: string };

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function readSheet(): Promise<Row[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    clientOptions: { subject: GMAIL_USER },
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!${PHONE_COL}${START_ROW}:${MSG_COL}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = res.data.values ?? [];

  return values
    .filter((row) => row[0] && row[1])
    .map((row) => ({
      phone: normalizePhone(String(row[0])),
      message: String(row[1]),
    }));
}

function normalizePhone(raw: string): string {
  // Keep only digits and leading +
  const stripped = raw.replace(/[^\d+]/g, "");
  return stripped.startsWith("+") ? stripped : `+${stripped}`;
}

// ─── WhatsApp sender ──────────────────────────────────────────────────────────

async function main() {
  console.log("Reading sheet...");
  const rows = await readSheet();
  console.log(`Found ${rows.length} rows to process.`);

  console.log("\nCreating Browserbase session...");
  const session = await createSession({ keepAlive: true, timeout: 3600 });

  const liveViewUrl = `https://www.browserbase.com/sessions/${session.id}`;
  console.log(`\n${"─".repeat(60)}`);
  console.log("  Open this URL to watch (and scan the QR code):");
  console.log(`  ${liveViewUrl}`);
  console.log(`${"─".repeat(60)}\n`);

  const { browser, page } = await connectToBrowser(session.connectUrl);

  const results: SendResult[] = [];

  try {
    console.log("Navigating to WhatsApp Web...");
    await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });

    // Wait for QR scan — the chat list appears once logged in
    console.log("Waiting for QR code scan (up to 5 minutes)...");
    await page.waitForSelector('[data-testid="chatlist-header"], #side', {
      timeout: 300_000,
    });
    console.log("Logged in. Starting sends...\n");

    for (let i = 0; i < rows.length; i++) {
      const { phone, message } = rows[i];
      console.log(`[${i + 1}/${rows.length}] Sending to ${phone}...`);

      const result = await sendMessage(page, phone, message);
      results.push(result);

      const label = result.status === "sent" ? "✓" : result.status === "skipped" ? "⚠" : "✗";
      console.log(`  ${label} ${result.status}${result.reason ? ` — ${result.reason}` : ""}`);

      if (i < rows.length - 1) {
        await page.waitForTimeout(DELAY_MS);
      }
    }
  } finally {
    await browser.close();
    await releaseSession(session.id);

    const logPath = join(process.cwd(), `whatsapp-log-${Date.now()}.json`);
    writeFileSync(logPath, JSON.stringify(results, null, 2));

    const sent = results.filter((r) => r.status === "sent").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors = results.filter((r) => r.status === "error").length;

    console.log(`\nDone. ${sent} sent, ${skipped} skipped, ${errors} errors.`);
    console.log(`Log saved to: ${logPath}`);
  }
}

async function sendMessage(
  page: import("playwright-core").Page,
  phone: string,
  message: string
): Promise<SendResult> {
  const url = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for either the send button or an error popup
    const result = await Promise.race([
      page
        .waitForSelector('[data-testid="compose-btn-send"], [aria-label="Send"]', { timeout: 20_000 })
        .then(() => "ready" as const),
      page
        .waitForSelector('[data-testid="alert-dialog"], [data-testid="popup-contents"]', {
          timeout: 20_000,
        })
        .then(() => "error-dialog" as const),
    ]);

    if (result === "error-dialog") {
      // Check for "invalid phone" text
      const dialogText = await page
        .locator('[data-testid="alert-dialog"], [data-testid="popup-contents"]')
        .first()
        .innerText()
        .catch(() => "unknown error");
      return { phone, status: "skipped", reason: dialogText.trim().slice(0, 120) };
    }

    // Click send
    const sendBtn = page.locator('[data-testid="compose-btn-send"], [aria-label="Send"]').first();
    await sendBtn.click();

    // Wait briefly for the message to send (tick appears next to message)
    await page.waitForTimeout(2000);

    return { phone, status: "sent" };
  } catch (err: any) {
    return { phone, status: "error", reason: err?.message?.slice(0, 120) ?? "unknown" };
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
