/**
 * Interactive daily review.
 * Run: npx ts-node src/scripts/upload/run.ts
 *
 * Fetches unread emails matching known patterns, extracts relevant info,
 * and asks you what to do before uploading to Qualia.
 */
import * as readline from "readline";
import { tmpdir } from "os";
import { join } from "path";
import { fetchMatchingEmails, saveAttachments, archiveEmail, type MatchedEmail } from "../../gmail";
import { withSession } from "../../browserbase";
import { searchOrders, resolveOrderId, type OrderSearchResult } from "../../utils/navigate";
import { uploadDocument } from "../../actions/upload-document";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function hr() {
  console.log("─".repeat(60));
}

/**
 * Strip trailing city + state from an address string before passing to Qualia search.
 * "607 Jasmin Drive Kirkwood MO" → "607 Jasmin Drive"
 * Qualia search works best with just the street portion.
 */
function streetOnly(address: string): string {
  // If last word is a 2-letter state abbreviation, remove it + the word before (city)
  return address.replace(/\s+[A-Z]{2}$/, "").replace(/\s+\S+$/, "").trim() || address;
}

// ─── Email patterns ───────────────────────────────────────────────────────────

interface EmailPattern {
  name: string;
  subject: RegExp;
  extractAddress: (subject: string) => string | null;
}

const PATTERNS: EmailPattern[] = [
  {
    name: "Docusign completed",
    subject: /^Completed: Please sign documents for /i,
    extractAddress: (s) => {
      const m = s.match(/^Completed: Please sign documents for (.+)$/i);
      return m?.[1]?.trim() ?? null;
    },
  },
  // Add more patterns here as workflows grow
];

// ─── Core flow ────────────────────────────────────────────────────────────────

async function processEmail(email: MatchedEmail, address: string): Promise<void> {
  console.log(`\nFrom:    ${email.from}`);
  console.log(`Subject: ${email.subject}`);
  console.log(`Address: ${address}`);
  console.log(`Attachments: ${email.attachments.map((a) => a.filename).join(", ") || "(none)"}`);

  if (email.attachments.length === 0) {
    const skip = await ask("No attachments found. Skip? [Y/n] ");
    if (skip.trim().toLowerCase() !== "n") {
      console.log("Skipped.");
      return;
    }
  }

  // Search Qualia for orders matching the address
  const searchQuery = streetOnly(address);
  console.log(`\nSearching Qualia for "${searchQuery}"...`);
  let orders: OrderSearchResult[] = [];
  await withSession(async (page) => {
    orders = await searchOrders(page, searchQuery);
  });

  if (orders.length === 0) {
    console.log("No Qualia orders found for that address.");
    const skip = await ask("Skip this email? [Y/n] ");
    if (skip.trim().toLowerCase() !== "n") return;
    return;
  }

  // Show results
  console.log(`\nFound ${orders.length} order(s):`);
  orders.forEach((o, i) => console.log(`  [${i + 1}] ${o.label}`));
  console.log(`  [a] Upload to ALL`);
  console.log(`  [s] Skip`);

  const choice = await ask("\nUpload to which order(s)? (number, comma-separated, a, or s): ");
  const trimmed = choice.trim().toLowerCase();

  if (trimmed === "s" || trimmed === "") {
    console.log("Skipped.");
    return;
  }

  let selected: OrderSearchResult[];
  if (trimmed === "a") {
    selected = orders;
  } else {
    const indices = trimmed
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < orders.length);
    if (indices.length === 0) {
      console.log("Invalid selection. Skipped.");
      return;
    }
    selected = indices.map((i) => orders[i]!);
  }

  // Save attachments to temp dir
  const tmpDir = join(tmpdir(), `qualia-${Date.now()}`);
  const filePaths = saveAttachments(email, tmpDir);

  // Upload to each selected order
  await withSession(async (page) => {
    for (const order of selected) {
      console.log(`\nResolving order ${order.orderNumber}...`);
      const internalId = await resolveOrderId(page, order.orderNumber);
      console.log(`Uploading to: ${order.label}`);
      for (const filePath of filePaths) {
        const filename = filePath.split("/").pop()!;
        console.log(`  → ${filename}`);
        await uploadDocument(page, internalId, filePath);
        console.log(`  ✓ Done`);
      }
    }
  });

  // Archive
  await archiveEmail(email.id);
  console.log(`\nEmail archived.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Qualia daily email review");
  hr();

  let totalFound = 0;

  for (const pattern of PATTERNS) {
    const emails = await fetchMatchingEmails(pattern.subject);

    for (const email of emails) {
      const address = pattern.extractAddress(email.subject);
      if (!address) continue;

      totalFound++;
      hr();
      await processEmail(email, address);
    }
  }

  if (totalFound === 0) {
    console.log("No matching unread emails found.");
  }

  hr();
  console.log("Done.");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
