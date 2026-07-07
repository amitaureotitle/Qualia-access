/**
 * Automation: process "Completed: Please sign documents for {address}" emails.
 *
 * For each unread matching email:
 *   1. Extract address from subject
 *   2. Download all PDF attachments
 *   3. Find the matching Qualia order (if multiple, take the earliest / lowest order number)
 *   4. Upload all PDFs to the order's Documents section
 *   5. Archive the email
 *
 * Emails that can't be auto-processed are left unread for manual review.
 */

import { google } from "googleapis";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withSession } from "../../browserbase";
import { fetchOrdersByAddress } from "../../utils/order-api";
import { uploadDocument } from "../../actions/upload-document";
import { archiveEmail } from "../../gmail";
import dotenv from "dotenv";
dotenv.config();

const SUBJECT_PREFIX = "Completed: Please sign documents for";

// ── Gmail helpers ─────────────────────────────────────────────────────────────

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

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const afterDate = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`;

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `is:unread subject:"${SUBJECT_PREFIX}" after:${afterDate}`,
    maxResults: 20,
  });

  const results = [];
  for (const msg of list.data.messages ?? []) {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the address portion: "Completed: Please sign documents for 123 Main St City ST" → "123 Main St City ST" */
function parseAddress(subject: string): string | null {
  const idx = subject.indexOf(SUBJECT_PREFIX);
  if (idx === -1) return null;
  const address = subject.slice(idx + SUBJECT_PREFIX.length).trim();
  return address.length > 0 ? address : null;
}

/** Sort order numbers ascending so the earliest (lowest sequence) comes first */
function sortByOrderNumber<T extends { order_number: string }>(orders: T[]): T[] {
  return [...orders].sort((a, b) => {
    const seqA = parseInt(a.order_number.split("-").pop() ?? "0", 10);
    const seqB = parseInt(b.order_number.split("-").pop() ?? "0", 10);
    return seqA - seqB;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Checking for DocuSign completion emails...`);

  const emails = await fetchMatchingEmails();
  if (emails.length === 0) {
    console.log("  No matching unread emails found.");
    return;
  }
  console.log(`  Found ${emails.length} email(s).`);

  for (const email of emails) {
    console.log(`\n  Subject: ${email.subject}`);

    const address = parseAddress(email.subject);
    if (!address) {
      console.log("  ⚠ Could not parse address — skipping (manual review needed)");
      continue;
    }
    console.log(`  Address: ${address}`);

    const pdfFiles = email.filePaths.filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log("  ⚠ No PDF attachments — skipping (manual review needed)");
      continue;
    }

    // API address1 is street-only ("7248 MacKenzie Road"), but the subject has
    // city+state appended without commas ("7248 MacKenzie Road St. Louis MO").
    // Search with just house number + first street word — always unique enough.
    const streetSearch = address.match(/^(\d+\s+\S+)/)?.[1] ?? address;
    const allOrders = await fetchOrdersByAddress(streetSearch);
    if (allOrders.length === 0) {
      console.log(`  ⚠ No orders found for "${streetSearch}" — skipping (manual review needed)`);
      continue;
    }

    // Pick the earliest order if multiple match
    const sorted = sortByOrderNumber(allOrders);
    const chosen = sorted[0]!;
    if (sorted.length > 1) {
      console.log(`  Multiple matches (${sorted.map(o => o.order_number).join(", ")}) — using earliest: ${chosen.order_number}`);
    }
    console.log(`  → ${chosen.order_number} (${chosen.qualia_id})`);

    let uploaded = false;
    await withSession(async (page) => {
      for (const filePath of pdfFiles) {
        await uploadDocument(page, chosen.qualia_id, filePath);
        console.log(`    ✓ Uploaded ${filePath.split("/").pop()}`);
      }
      uploaded = true;
    });

    if (uploaded) {
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
