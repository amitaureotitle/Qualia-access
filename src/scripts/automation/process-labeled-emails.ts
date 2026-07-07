/**
 * Automation: process emails labeled "Docs sent to Qualia".
 *
 * For each labeled email:
 *   1. Extract street address from subject (tries multiple patterns)
 *   2. Find matching Qualia order(s) via pipeline API
 *   3. Upload all PDF attachments to each matched order
 *   4. Remove the label + archive the email
 *
 * Emails where the order can't be determined are left labeled for manual review.
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

const LABEL_ID = "Label_6"; // "Docs sent to Qualia"

function makeGmail() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  return google.gmail({ version: "v1", auth });
}

async function fetchLabeledEmails(): Promise<Array<{ id: string; subject: string; filePaths: string[] }>> {
  const gmail = makeGmail();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `label:${LABEL_ID}`,
    maxResults: 20,
  });

  const results = [];
  for (const msg of list.data.messages ?? []) {
    const id = msg.id!;
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";

    const dir = join(tmpdir(), `qualia-label-${id}`);
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

/** Remove the "Docs sent to Qualia" label from a message */
async function removeLabel(messageId: string): Promise<void> {
  const gmail = makeGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: [LABEL_ID] },
  });
}

/**
 * Try to extract a street address from the email subject.
 * Tries Dropbox Sign format first, then a generic street-number pattern.
 */
function extractAddress(subject: string): string | null {
  // Dropbox Sign: "... - {address} - signed by ..."
  const signedByIdx = subject.lastIndexOf(" - signed by ");
  if (signedByIdx !== -1) {
    const parts = subject.slice(0, signedByIdx).split(" - ");
    const addr = parts[parts.length - 1]?.trim();
    if (addr) return addr;
  }

  // DocuSign: "Completed: Please sign documents for {address}"
  const docusignPrefix = "Completed: Please sign documents for";
  const dsIdx = subject.indexOf(docusignPrefix);
  if (dsIdx !== -1) {
    const addr = subject.slice(dsIdx + docusignPrefix.length).trim();
    if (addr) return addr;
  }

  // Generic: look for a house number followed by a street name
  const genericMatch = subject.match(/\b(\d+\s+[A-Za-z][\w\s.]+(?:Dr|Drive|St|Street|Ave|Avenue|Rd|Road|Blvd|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle)\b[^,]*)/i);
  if (genericMatch) return genericMatch[1]?.trim() ?? null;

  return null;
}

function streetOnly(address: string): string {
  return address.split(",")[0]?.trim() ?? address;
}

async function main() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Checking for "Docs sent to Qualia" labeled emails...`);

  const emails = await fetchLabeledEmails();
  if (emails.length === 0) {
    console.log("  No labeled emails found.");
    return;
  }
  console.log(`  Found ${emails.length} email(s).`);

  for (const email of emails) {
    console.log(`\n  Subject: ${email.subject}`);

    const address = extractAddress(email.subject);
    if (!address) {
      console.log("  ⚠ Could not extract address from subject — leaving labeled for manual review");
      continue;
    }

    const street = streetOnly(address);
    console.log(`  Address: ${street}`);

    const pdfFiles = email.filePaths.filter((f) => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      console.log("  ⚠ No PDF attachments — leaving labeled for manual review");
      continue;
    }

    const orders = await fetchOrdersByAddress(street);
    if (orders.length === 0) {
      console.log(`  ⚠ No orders found for "${street}" — leaving labeled for manual review`);
      continue;
    }
    console.log(`  Matched ${orders.length} order(s): ${orders.map((o) => o.order_number).join(", ")}`);

    let uploaded = false;
    await withSession(async (page) => {
      for (const order of orders) {
        console.log(`  → ${order.order_number} (${order.qualia_id})`);
        for (const filePath of pdfFiles) {
          await uploadDocument(page, order.qualia_id, filePath);
          console.log(`    ✓ Uploaded ${filePath.split("/").pop()}`);
        }
      }
      uploaded = true;
    });

    if (uploaded) {
      await removeLabel(email.id);
      await archiveEmail(email.id);
      console.log(`  ✓ Label removed + email archived`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
