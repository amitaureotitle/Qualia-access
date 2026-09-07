/**
 * Automation: process DataTrace bundle emails (Gmail label: datatrace-bundle).
 *
 * For each labeled email:
 *   1. Extract order number from subject ("Image Bundle for order: 2026-MO-XXX")
 *   2. Get first DataTrace PDF URL from email HTML body
 *   3. Look up qualia_id via pipeline API
 *   4. Download PDF and parse Schedule B (Requirements + Exceptions)
 *   5. Generate Resware XML and import via Qualia "Import from File" dialog
 *   6. Remove label + archive email
 */

import { google } from "googleapis";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Page } from "playwright-core";
import { withSession } from "../../browserbase";
import { fetchOrderByNumber } from "../../utils/order-api";
import { dismissStartupModals } from "../../utils/dismiss-modals";
import { archiveEmail } from "../../gmail";
import dotenv from "dotenv";
dotenv.config();

const LABEL_ID = "Label_5462772604191950879"; // datatrace-bundle
const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";

// ── Gmail helpers ────────────────────────────────────────────────────────────

function makeGmail() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  return google.gmail({ version: "v1", auth });
}

interface EmailRecord {
  id: string;
  subject: string;
  htmlBody: string;
}

async function fetchLabeledEmails(): Promise<EmailRecord[]> {
  const gmail = makeGmail();
  const list = await gmail.users.messages.list({
    userId: "me",
    labelIds: [LABEL_ID],
    maxResults: 20,
  });

  const results: EmailRecord[] = [];
  for (const msg of list.data.messages ?? []) {
    const id = msg.id!;
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";

    let htmlBody = "";
    function extractBody(part: any): void {
      if (part.mimeType === "text/html" && part.body?.data) {
        htmlBody += Buffer.from(part.body.data, "base64url").toString("utf8");
      }
      if (part.mimeType === "text/plain" && !htmlBody && part.body?.data) {
        htmlBody += Buffer.from(part.body.data, "base64url").toString("utf8");
      }
      for (const p of part.parts ?? []) extractBody(p);
    }
    extractBody(full.data.payload);

    results.push({ id, subject, htmlBody });
  }
  return results;
}

async function removeLabel(messageId: string): Promise<void> {
  const gmail = makeGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: [LABEL_ID] },
  });
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function extractOrderNumber(subject: string): string | null {
  const m = subject.match(/Image Bundle for order:\s*(\S+)/i);
  return m ? m[1]! : null;
}

function extractDataTraceUrl(body: string): string | null {
  const m = body.match(/https?:\/\/tv\.datatracetitle\.com\/DocHandler\.ashx\?[^\s"'>]*/);
  return m ? m[0] : null;
}

function downloadPdf(url: string): string {
  const dest = join(tmpdir(), `datatrace-${Date.now()}.pdf`);
  const result = spawnSync("curl", ["-L", "-s", "-o", dest, url], { timeout: 30_000 });
  if (result.status !== 0) throw new Error(`curl download failed: ${result.stderr?.toString()}`);
  return dest;
}

function extractPdfText(pdfPath: string): string {
  try {
    return execSync(`"${PDFTOTEXT}" "${pdfPath}" -`, { encoding: "utf8" });
  } catch {
    return "";
  }
}

function parseScheduleB(text: string): { requirements: string[]; exceptions: string[] } {
  const sec1Idx = text.indexOf("SCHEDULE B-SECTION ONE");
  const sec2Idx = text.indexOf("SCHEDULE B-SECTION TWO");
  if (sec1Idx === -1 || sec2Idx === -1) {
    throw new Error("Could not find SCHEDULE B-SECTION ONE or TWO in PDF text");
  }

  const formFeedIdx = text.indexOf("\f", sec2Idx);
  const sec2End = formFeedIdx > -1 ? formFeedIdx : text.length;

  function parseItems(sectionText: string): string[] {
    const items: string[] = [];
    let numPrefix = "";
    let bodyLines: string[] = [];

    function flush() {
      const body = bodyLines.join(" ").replace(/\s+/g, " ").trim();
      if (numPrefix && body) items.push(`${numPrefix} ${body}`);
      else if (!numPrefix && body) items.push(body);
      numPrefix = "";
      bodyLines = [];
    }

    for (const line of sectionText.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+\.$/.test(trimmed)) {
        flush();
        numPrefix = trimmed;
      } else if (/^\d+\. [A-Za-z(]/.test(trimmed)) {
        flush();
        numPrefix = "";
        bodyLines = [trimmed];
      } else if (trimmed && (numPrefix || bodyLines.length > 0)) {
        bodyLines.push(trimmed);
      }
    }
    flush();
    return items;
  }

  return {
    requirements: parseItems(text.slice(sec1Idx, sec2Idx)),
    exceptions: parseItems(text.slice(sec2Idx, sec2End)),
  };
}

// ── XML generation ───────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripItemNumber(item: string): string {
  return item.replace(/^\d+\.\s+/, "");
}

function buildCommitmentXml(
  orderNumber: string,
  requirements: string[],
  exceptions: string[]
): string {
  const pad = "          "; // 10 spaces, matches sample format

  const reqText = [
    "[#] The following are the requirements to be complied with:&lt;br&gt;",
    ...requirements.map((r) => `[#] ${xmlEscape(stripItemNumber(r))}`),
  ].join(`\n\n${pad}`);

  const excText = [
    "[#] Schedule B of the policy or policies to be issued will contain exceptions to the following matters unless the same are disposed of in accordance with underwriting guidelines:",
    ...exceptions.map((e) => `[#] ${xmlEscape(stripItemNumber(e))}`),
  ].join(`\n\n${pad}`);

  const fn = xmlEscape(orderNumber);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CC_Export>
  <CC_File File_Number="${fn}">
    <CCMASTER>
      <FILENO Field_Type="C">${fn}</FILENO>
    </CCMASTER>
    <PROPERTY>
      <PFILENO Field_Type="C">${fn}</PFILENO>
      <PARCEL>
        <FILENO Field_Type="C">${fn}</FILENO>
        <TYPECODE Field_Type="C">CAR</TYPECODE>
        <TEXT Field_Type="M">${pad}${reqText}</TEXT>
      </PARCEL>
      <PARCEL>
        <FILENO Field_Type="C">${fn}</FILENO>
        <TYPECODE Field_Type="C">CE</TYPECODE>
        <TEXT Field_Type="M">${pad}${excText}</TEXT>
      </PARCEL>
    </PROPERTY>
  </CC_File>
</CC_Export>`;
}

// ── Qualia XML import ────────────────────────────────────────────────────────

async function importXmlToQualia(
  page: Page,
  qualiaId: string,
  xmlPath: string
): Promise<void> {
  await page.goto(
    `https://aureotitle.qualia.io/orders/${qualiaId}/title/commitment?section=requirements`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await dismissStartupModals(page);
  await page.waitForTimeout(4000);

  // Open Import from File popup — custom element <uploadcommitment>
  await page.evaluate(`document.querySelector('uploadcommitment').click()`);
  await page.waitForTimeout(800);

  // Set XML file
  await page.setInputFiles('input[type="file"]', xmlPath);
  await page.waitForTimeout(1500);

  // Click Title Provider dropdown (search selection inside <uploadcommitmentpopup>)
  await page.evaluate(`
    (function() {
      var input = document.querySelector('input[data-schema-key="titleServiceProvider"]');
      if (input) {
        var dd = input.closest('.ui.dropdown');
        if (dd) dd.click();
      }
    })()
  `);
  await page.waitForTimeout(400);

  // Select First American
  await page.evaluate(`
    (function() {
      var item = document.querySelector('.item[data-value="First American"]');
      if (item) item.click();
    })()
  `);
  await page.waitForTimeout(1500);

  // Wait for <submitcommitment> to become enabled, then click it
  await page.waitForFunction(
    `(function() { var b = document.querySelector('submitcommitment'); return b && !b.classList.contains('disabled'); })()`,
    { timeout: 5000 }
  ).catch(() => {});
  await page.evaluate(`document.querySelector('submitcommitment').click()`);
  await page.waitForTimeout(2000);

  // Click "Import" in the Confirm Import popup — <yes class="ui negative approve button">
  await page.evaluate(`
    (function() {
      var yes = document.querySelector('yes');
      if (yes) { yes.click(); return; }
      // Fallback: any visible element with text "Import"
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].children.length === 0 && all[i].textContent.trim() === 'Import' && all[i].offsetParent !== null) {
          all[i].click(); return;
        }
      }
    })()
  `);
  await page.waitForTimeout(6000); // wait for import to complete
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Checking for DataTrace bundle emails...`);

  const emails = await fetchLabeledEmails();
  if (emails.length === 0) {
    console.log("  No datatrace-bundle emails found.");
    return;
  }
  console.log(`  Found ${emails.length} email(s).`);

  interface WorkItem {
    emailId: string;
    subject: string;
    orderNumber: string;
    qualiaId: string;
    requirements: string[];
    exceptions: string[];
  }

  const workQueue: WorkItem[] = [];

  for (const email of emails) {
    console.log(`\n  Subject: ${email.subject}`);

    const orderNumber = extractOrderNumber(email.subject);
    if (!orderNumber) {
      console.log("  ⚠ Could not extract order number — skipping");
      continue;
    }

    const pdfUrl = extractDataTraceUrl(email.htmlBody);
    if (!pdfUrl) {
      console.log("  ⚠ No DataTrace URL in email body — skipping");
      continue;
    }

    const order = await fetchOrderByNumber(orderNumber);
    if (!order) {
      console.log(`  ⚠ Order ${orderNumber} not found in pipeline — skipping`);
      continue;
    }
    console.log(`  Order: ${orderNumber} → ${order.qualia_id}`);

    let pdfPath: string | null = null;
    let requirements: string[] = [];
    let exceptions: string[] = [];
    try {
      pdfPath = downloadPdf(pdfUrl);
      const text = extractPdfText(pdfPath);
      const parsed = parseScheduleB(text);
      requirements = parsed.requirements;
      exceptions = parsed.exceptions;
      console.log(`  Parsed: ${requirements.length} requirements, ${exceptions.length} exceptions`);
    } catch (err) {
      console.log(`  ⚠ PDF parsing failed: ${err} — skipping`);
      continue;
    } finally {
      if (pdfPath) try { unlinkSync(pdfPath); } catch {}
    }

    if (requirements.length === 0 && exceptions.length === 0) {
      console.log("  ⚠ No items parsed from PDF — skipping");
      continue;
    }

    workQueue.push({ emailId: email.id, subject: email.subject, orderNumber, qualiaId: order.qualia_id, requirements, exceptions });
  }

  if (workQueue.length === 0) {
    console.log("\nNothing to process.");
    return;
  }

  // Deduplicate by qualiaId
  const seenQualiaIds = new Map<string, string[]>();
  const deduped: WorkItem[] = [];
  for (const item of workQueue) {
    if (!seenQualiaIds.has(item.qualiaId)) {
      seenQualiaIds.set(item.qualiaId, [item.emailId]);
      deduped.push(item);
    } else {
      seenQualiaIds.get(item.qualiaId)!.push(item.emailId);
    }
  }
  console.log(`\n  ${deduped.length} unique order(s) to process`);

  for (const item of deduped) {
    console.log(`\n  Processing ${item.orderNumber} (${item.qualiaId})`);

    const xmlPath = join(tmpdir(), `commitment-${item.orderNumber}-${Date.now()}.xml`);
    let ok = false;
    try {
      const xml = buildCommitmentXml(item.orderNumber, item.requirements, item.exceptions);
      writeFileSync(xmlPath, xml, "utf-8");

      await withSession(async (page) => {
        await importXmlToQualia(page, item.qualiaId, xmlPath);
        ok = true;
      }, { timeout: 3600 });
    } catch (err) {
      console.log(`  ✗ Error: ${err}`);
    } finally {
      try { unlinkSync(xmlPath); } catch {}
    }

    if (ok) {
      const allEmailIds = seenQualiaIds.get(item.qualiaId) ?? [item.emailId];
      for (const emailId of allEmailIds) {
        await removeLabel(emailId);
        await archiveEmail(emailId);
      }
      console.log(`  ✓ Done. Archived ${allEmailIds.length} email(s) for ${item.orderNumber}`);
    }

    // Brief pause between sessions to avoid Browserbase rate limits
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
