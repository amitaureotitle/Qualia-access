/**
 * Automation: process "Contract Amendment" emails (buyer or seller side).
 *
 * Matches any Dropbox Sign amendment email. The PDF is the real discriminator:
 * if it contains a new closing date the email is processed; otherwise it's
 * left unread for manual review.
 *
 * For each processable email:
 *   1. Extract address from subject
 *   2. Extract new closing date from PDF via pdftotext
 *   3. Find all matching Qualia orders by address
 *   4. Update closing date + upload PDF on every matched order
 *   5. Archive the email
 */

import { google } from "googleapis";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withSession } from "../../browserbase";
import { fetchOrdersByAddress } from "../../utils/order-api";
import { uploadDocument } from "../../actions/upload-document";
import { updateClosingDate } from "../../actions/update-closing-date";
import { updatePurchasePrice } from "../../actions/update-purchase-price";
import { archiveEmail } from "../../gmail";
import dotenv from "dotenv";
dotenv.config();

const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";
const SUBJECT_TRIGGER = "Contract Amendment";

// ── Gmail helpers ────────────────────────────────────────────────────────────

function makeGmail() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  return google.gmail({ version: "v1", auth });
}

async function fetchMatchingEmails(): Promise<Array<{ id: string; subject: string; filePaths: string[] }>> {
  const gmail = makeGmail();
  // Only look at emails from the last 30 days to avoid processing stale unread messages
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const afterDate = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`;

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `is:unread subject:"${SUBJECT_TRIGGER}" after:${afterDate}`,
    maxResults: 20,
  });
  const messages = list.data.messages ?? [];
  const results = [];

  for (const msg of messages) {
    const id = msg.id!;
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";

    const dir = join(tmpdir(), `qualia-email-${id}`);
    mkdirSync(dir, { recursive: true });
    const filePaths: string[] = [];

    async function walk(part: any) {
      if (part.filename && part.body?.attachmentId) {
        const res = await gmail.users.messages.attachments.get({ userId: "me", messageId: id, id: part.body.attachmentId });
        const dest = join(dir, part.filename);
        writeFileSync(dest, Buffer.from(res.data.data ?? "", "base64url"));
        filePaths.push(dest);
      }
      for (const p of part.parts ?? []) await walk(p);
    }
    await walk(full.data.payload);
    results.push({ id, subject, filePaths });
  }
  return results;
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Parse a Dropbox Sign amendment subject into type + address.
 *
 * Handles two formats:
 *   Standard:    "...{date} - {type} - {address} - signed by {parties}"
 *   Alternative: "...{type} for {date} - {address} - signed by {parties}"
 *
 * Strategy: anchor on " - signed by " then work backwards — the segment
 * immediately before it is always the address.
 */
function parseSubject(subject: string): { type: string; address: string } | null {
  const signedByIdx = subject.lastIndexOf(" - signed by ");
  if (signedByIdx === -1) return null;

  const parts = subject.slice(0, signedByIdx).split(" - ");
  const address = parts[parts.length - 1]?.trim() ?? "";
  if (!address) return null;

  if (parts.length >= 3) {
    // Standard: "...{date} - {type} - {address} - signed by..."
    const type = parts[parts.length - 2]?.trim() ?? "";
    return { type, address };
  }

  if (parts.length === 2) {
    const prefix = parts[0] ?? "";
    // Alternative A: "...{type} for {date} - {address} - signed by..."
    const withDate = prefix.match(/You've been copied on (.+?) for /i);
    if (withDate) return { type: withDate[1]!.trim(), address };
    // Alternative B: "...{type} - {address} - signed by..." (no date at all)
    const plain = prefix.match(/You've been copied on (.+)/i);
    const type = plain?.[1]?.trim() ?? "";
    if (type) return { type, address };
  }

  return null;
}

/** Extract street portion of address ("607 Jasmin Dr, Kirkwood..." → "607 Jasmin Dr") */
function streetOnly(address: string): string {
  return address.split(",")[0]?.trim() ?? address;
}

/** Run pdftotext and return text, or empty string on failure */
function pdfText(filePath: string): string {
  try {
    return execSync(`"${PDFTOTEXT}" "${filePath}" -`, { encoding: "utf8" });
  } catch {
    return "";
  }
}

const MONTHS: { [k: string]: string } = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

/** Extract new purchase price from amendment PDF text → plain numeric string, e.g. "42500" */
function extractPurchasePrice(text: string): string | null {
  const m = text.match(/purchase price has been modified to\s+\$?([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  // Strip commas and trailing .00
  return m[1]!.replace(/,/g, "").replace(/\.00$/, "");
}

/** Extract new closing date from amendment PDF text (MM/DD/YYYY or written-month format) */
function extractClosingDate(text: string): string | null {
  // Numeric: "on or before 05/28/2026" or "modified to 05/28/2026"
  const numM = text.match(/(?:on\s+or\s+before|modified\s+to)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (numM) return numM[1] ?? null;

  // Written month: "modified to June 30, 2026" or "on or before June 30, 2026"
  const monthM = text.match(
    /(?:on\s+or\s+before|modified\s+to)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})/i
  );
  if (monthM) {
    const month = MONTHS[monthM[1]!.toLowerCase()];
    const day = monthM[2]!.padStart(2, "0");
    const year = monthM[3]!;
    return `${month}/${day}/${year}`;
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Checking for closing date amendment emails...`);

  const emails = await fetchMatchingEmails();
  if (emails.length === 0) {
    console.log("  No matching unread emails found.");
    return;
  }
  console.log(`  Found ${emails.length} email(s).`);

  for (const email of emails) {
    console.log(`\n  Subject: ${email.subject}`);

    // 1. Parse subject
    const parsed = parseSubject(email.subject);
    if (!parsed) {
      console.log("  ⚠ Could not parse subject — skipping (manual review needed)");
      continue;
    }

    const address = parsed.address;
    const street = streetOnly(address);
    console.log(`  Address: ${address}`);

    // 2. Extract closing date from PDF
    const pdfFiles = email.filePaths.filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log("  ⚠ No PDF attachment — skipping (manual review needed)");
      continue;
    }

    let newDate: string | null = null;
    let newPrice: string | null = null;
    for (const pdf of pdfFiles) {
      const text = pdfText(pdf);
      if (!newDate) newDate = extractClosingDate(text);
      if (!newPrice) newPrice = extractPurchasePrice(text);
      if (newDate && newPrice) break;
    }

    if (newDate) console.log(`  New closing date: ${newDate}`);
    if (newPrice) console.log(`  New purchase price: $${newPrice}`);
    if (!newDate && !newPrice) console.log("  ℹ No date or price found in PDF — will upload document only");

    // 3–5. Look up orders via API, then open browser only for the actual update + upload
    const orders = await fetchOrdersByAddress(street);
    if (orders.length === 0) {
      console.log(`  ⚠ No orders found for "${street}" — leaving unread for manual review`);
      continue;
    }
    console.log(`  Matched ${orders.length} order(s): ${orders.map((o) => o.order_number).join(", ")}`);

    let processed = false;
    await withSession(async (page) => {
      for (const order of orders) {
        console.log(`  → ${order.order_number} (${order.qualia_id})`);

        if (newDate) {
          await updateClosingDate(page, order.qualia_id, newDate);
          console.log(`    ✓ Closing date updated to ${newDate}`);
        }
        if (newPrice) {
          await updatePurchasePrice(page, order.qualia_id, newPrice);
          console.log(`    ✓ Purchase price updated to $${newPrice}`);
        }

        for (const filePath of email.filePaths) {
          await uploadDocument(page, order.qualia_id, filePath);
          console.log(`    ✓ Uploaded ${filePath.split("/").pop()}`);
        }
      }
      processed = true;
    });

    if (processed) {
      await archiveEmail(email.id);
      console.log(`  ✓ Email archived`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
