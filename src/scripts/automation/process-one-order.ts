/**
 * Process a single order's DataTrace bundle email.
 * Usage: ORDER=2026-MO-185 npx ts-node src/scripts/automation/process-one-order.ts
 *
 * Steps:
 *   1. Find the datatrace-bundle email for the order in Gmail
 *   2. Download DataTrace PDF
 *   3. Parse Schedule B (requirements + exceptions)
 *   4. Build Resware XML and import into Qualia commitment page
 *   5. Upload the original PDF to Qualia Documents
 *   6. Archive the email
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

const TARGET_ORDER = process.env.ORDER ?? "2026-MO-185";
const LABEL_ID = "Label_5462772604191950879";
const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";

function makeGmail() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  return google.gmail({ version: "v1", auth });
}

async function removeLabel(messageId: string) {
  const gmail = makeGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: [LABEL_ID] },
  });
}

function extractDataTraceUrl(body: string): string | null {
  const m = body.match(/https?:\/\/tv\.datatracetitle\.com\/DocHandler\.ashx\?[^\s"'>]*/);
  return m ? m[0] : null;
}

function downloadPdf(url: string): string {
  const dest = join(tmpdir(), `datatrace-${Date.now()}.pdf`);
  const result = spawnSync("curl", ["-L", "-s", "-o", dest, url], { timeout: 30_000 });
  if (result.status !== 0) throw new Error(`curl failed: ${result.stderr?.toString()}`);
  return dest;
}

function extractPdfText(pdfPath: string): string {
  return execSync(`"${PDFTOTEXT}" "${pdfPath}" -`, { encoding: "utf8" });
}

function parseScheduleB(text: string): { requirements: string[]; exceptions: string[] } {
  const sec1Idx = text.indexOf("SCHEDULE B-SECTION ONE");
  const sec2Idx = text.indexOf("SCHEDULE B-SECTION TWO");
  if (sec1Idx === -1 || sec2Idx === -1) throw new Error("Could not find SCHEDULE B sections");

  // pdftotext inserts \f at every page break — NOT a section boundary.
  // Use real section-end markers instead.
  const endMarkers = ["SCHEDULE C", "IN WITNESS WHEREOF", "ENDORSEMENT"];
  let sec2End = text.length;
  for (const marker of endMarkers) {
    const idx = text.indexOf(marker, sec2Idx + 30);
    if (idx > -1 && idx < sec2End) sec2End = idx;
  }

  function parseItems(sectionText: string): string[] {
    const items: string[] = [];
    let numPrefix = "";
    let bodyLines: string[] = [];

    function flush() {
      const body = bodyLines.join(" ").replace(/\s+/g, " ").trim();
      if (numPrefix && body) items.push(`${numPrefix} ${body}`);
      else if (!numPrefix && body) items.push(body);
      numPrefix = ""; bodyLines = [];
    }

    for (const line of sectionText.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+\.$/.test(trimmed)) { flush(); numPrefix = trimmed; }
      else if (/^\d+\. [A-Za-z(]/.test(trimmed)) { flush(); numPrefix = ""; bodyLines = [trimmed]; }
      else if (trimmed && (numPrefix || bodyLines.length > 0)) { bodyLines.push(trimmed); }
    }
    flush();
    return items;
  }

  return {
    requirements: parseItems(text.slice(sec1Idx, sec2Idx)),
    exceptions: parseItems(text.slice(sec2Idx, sec2End)),
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripItemNumber(item: string): string {
  return item.replace(/^\d+\.\s+/, "");
}

function buildCommitmentXml(orderNumber: string, requirements: string[], exceptions: string[]): string {
  const pad = "          ";
  const fn = xmlEscape(orderNumber);

  const reqText = [
    "[#] The following are the requirements to be complied with:&lt;br&gt;",
    ...requirements.map((r) => `[#] ${xmlEscape(stripItemNumber(r))}`),
  ].join(`\n\n${pad}`);

  const excText = [
    "[#] Schedule B of the policy or policies to be issued will contain exceptions to the following matters unless the same are disposed of in accordance with underwriting guidelines:",
    ...exceptions.map((e) => `[#] ${xmlEscape(stripItemNumber(e))}`),
  ].join(`\n\n${pad}`);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CC_Export>
  <CC_File File_Number="${fn}">
    <CCMASTER><FILENO Field_Type="C">${fn}</FILENO></CCMASTER>
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

async function importXmlToQualia(page: Page, qualiaId: string, xmlPath: string): Promise<void> {
  await page.goto(
    `https://aureotitle.qualia.io/orders/${qualiaId}/title/commitment?section=requirements`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await dismissStartupModals(page);
  await page.waitForTimeout(4000);

  await page.evaluate(`document.querySelector('uploadcommitment').click()`);
  await page.waitForTimeout(800);

  await page.setInputFiles('input[type="file"]', xmlPath);
  await page.waitForTimeout(1500);

  await page.evaluate(`
    (function() {
      var input = document.querySelector('input[data-schema-key="titleServiceProvider"]');
      if (input) { var dd = input.closest('.ui.dropdown'); if (dd) dd.click(); }
    })()
  `);
  await page.waitForTimeout(400);

  await page.evaluate(`
    (function() {
      var item = document.querySelector('.item[data-value="First American"]');
      if (item) item.click();
    })()
  `);
  await page.waitForTimeout(1500);

  await page.waitForFunction(
    `(function() { var b = document.querySelector('submitcommitment'); return b && !b.classList.contains('disabled'); })()`,
    { timeout: 5000 }
  ).catch(() => {});

  await page.evaluate(`document.querySelector('submitcommitment').click()`);
  await page.waitForTimeout(2000);

  await page.evaluate(`
    (function() {
      var yes = document.querySelector('yes');
      if (yes) { yes.click(); return; }
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].children.length === 0 && all[i].textContent.trim() === 'Import' && all[i].offsetParent !== null) {
          all[i].click(); return;
        }
      }
    })()
  `);
  await page.waitForTimeout(6000);
}

async function uncheckHeaderNumbering(page: Page, qualiaId: string, section: "requirements" | "exceptions"): Promise<void> {
  await page.goto(
    `https://aureotitle.qualia.io/orders/${qualiaId}/title/commitment?section=${section}`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await dismissStartupModals(page);
  await page.waitForTimeout(3000);

  // Click the text content of the first condition to activate its per-item toolbar
  await page.evaluate(`
    (function() {
      var conditions = document.querySelector('conditions');
      if (!conditions || !conditions.children[0]) return;
      var textEl = conditions.children[0].querySelector('editablefield, conditiontext, [contenteditable]');
      if (textEl) textEl.click();
      else conditions.children[0].click();
    })()
  `);
  await page.waitForTimeout(500);

  // The per-item toolbar button is <skipnumberingbutton>.
  // data-content="Remove List Format" = numbered (needs clicking to strip).
  // data-content="Apply List Format"  = already plain — skip.
  const result: string = await page.evaluate(`
    (function() {
      var conditions = document.querySelector('conditions');
      if (!conditions || !conditions.children[0]) return 'no conditions element';
      var btn = conditions.children[0].querySelector('skipnumberingbutton');
      if (!btn) return 'skipnumberingbutton not found in first condition';
      var dc = btn.getAttribute('data-content') || '';
      if (dc === 'Remove List Format') {
        btn.click();
        return 'clicked — list format removed from header';
      }
      return 'already plain (dc=' + dc + ') — no action needed';
    })()
  `);
  console.log(`  [${section}] header: ${result}`);
  await page.waitForTimeout(800);
}

async function uploadPdfToDocuments(
  page: Page,
  qualiaId: string,
  pdfPath: string,
  orderNumber: string
): Promise<void> {
  await page.goto(
    `https://aureotitle.qualia.io/orders/${qualiaId}/documents`,
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await dismissStartupModals(page);
  await page.waitForTimeout(3000);

  // Inspect the page to find upload trigger and file input
  const pageInfo: string = await page.evaluate(`
    (function() {
      var triggers = [];
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var tag = all[i].tagName.toLowerCase();
        var dc = all[i].getAttribute('data-content') || '';
        var cls = all[i].className || '';
        var txt = all[i].children.length === 0 ? (all[i].textContent || '').trim() : '';
        if (tag.includes('upload') || dc.toLowerCase().includes('upload') ||
            txt.toLowerCase() === 'upload' || txt.toLowerCase() === 'add document') {
          triggers.push(tag + ' data-content="' + dc + '" text="' + txt + '" class="' + cls + '"');
        }
      }
      var fileInputs = document.querySelectorAll('input[type="file"]');
      return JSON.stringify({ triggers: triggers.slice(0, 10), fileInputs: fileInputs.length });
    })()
  `);
  console.log(`  Documents page info: ${pageInfo}`);

  const info = JSON.parse(pageInfo);

  if (info.triggers.length === 0 && info.fileInputs === 0) {
    // Try clicking an upload button by visible text
    const clicked: string = await page.evaluate(`
      (function() {
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var txt = (all[i].textContent || '').trim();
          if ((txt === 'Upload' || txt === 'Add Document' || txt === 'Upload Document') && all[i].offsetParent !== null) {
            all[i].click();
            return 'clicked: ' + all[i].tagName + ' "' + txt + '"';
          }
        }
        return 'no upload trigger found';
      })()
    `);
    console.log(`  Upload trigger: ${clicked}`);
    await page.waitForTimeout(1000);
  } else {
    // Click the first upload trigger found
    const triggered: string = await page.evaluate(`
      (function() {
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var tag = all[i].tagName.toLowerCase();
          var dc = all[i].getAttribute('data-content') || '';
          var txt = all[i].children.length === 0 ? (all[i].textContent || '').trim() : '';
          if (tag.includes('upload') || dc.toLowerCase().includes('upload')) {
            all[i].click();
            return 'clicked: ' + tag + ' "' + dc + '"';
          }
        }
        return 'no custom upload element found';
      })()
    `);
    console.log(`  Upload trigger: ${triggered}`);
    await page.waitForTimeout(1000);
  }

  // Set the file into whichever file input is visible
  const fileInputCount: number = await page.evaluate(`document.querySelectorAll('input[type="file"]').length`);
  if (fileInputCount > 0) {
    await page.setInputFiles('input[type="file"]', pdfPath);
    await page.waitForTimeout(1500);
    console.log(`  PDF file set (${fileInputCount} input(s) found)`);
  } else {
    console.log(`  ⚠ No file input found on documents page — PDF upload skipped`);
    return;
  }

  // Look for a name/title field and fill with order number
  await page.evaluate(`
    (function() {
      var inputs = document.querySelectorAll('input[type="text"], input[placeholder]');
      for (var i = 0; i < inputs.length; i++) {
        var ph = (inputs[i].placeholder || '').toLowerCase();
        if (ph.includes('name') || ph.includes('title') || ph.includes('document')) {
          inputs[i].value = 'DataTrace Search Package';
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    })()
  `);
  await page.waitForTimeout(500);

  // Click Save / Upload / Submit
  const saved: string = await page.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var txt = (all[i].textContent || '').trim();
        if ((txt === 'Save' || txt === 'Upload' || txt === 'Submit') && all[i].offsetParent !== null) {
          all[i].click();
          return 'clicked: "' + txt + '"';
        }
      }
      return 'no save button found';
    })()
  `);
  console.log(`  Save result: ${saved}`);
  await page.waitForTimeout(4000);
}

async function main() {
  console.log(`\nProcessing order: ${TARGET_ORDER}`);

  const gmail = makeGmail();
  const list = await gmail.users.messages.list({ userId: "me", labelIds: [LABEL_ID], maxResults: 50 });
  const messages = list.data.messages ?? [];

  let emailId: string | null = null;
  let pdfUrl: string | null = null;

  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id!, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";

    console.log(`  Checking: "${subject}"`);
    if (!subject.includes(TARGET_ORDER)) continue;

    let htmlBody = "";
    function extractBody(part: any): void {
      if (part.mimeType === "text/html" && part.body?.data) htmlBody += Buffer.from(part.body.data, "base64url").toString("utf8");
      if (part.mimeType === "text/plain" && !htmlBody && part.body?.data) htmlBody += Buffer.from(part.body.data, "base64url").toString("utf8");
      for (const p of part.parts ?? []) extractBody(p);
    }
    extractBody(full.data.payload);

    const url = extractDataTraceUrl(htmlBody);
    if (url) { emailId = msg.id!; pdfUrl = url; break; }
  }

  if (!emailId || !pdfUrl) throw new Error(`No datatrace-bundle email found for ${TARGET_ORDER}`);
  console.log(`Found email. Downloading PDF...`);

  const order = await fetchOrderByNumber(TARGET_ORDER);
  if (!order) throw new Error(`Order ${TARGET_ORDER} not found in pipeline`);
  console.log(`Qualia ID: ${order.qualia_id}`);

  // Keep pdfPath alive through both parse and upload
  const pdfPath = downloadPdf(pdfUrl);
  let requirements: string[] = [];
  let exceptions: string[] = [];

  try {
    const text = extractPdfText(pdfPath);
    const parsed = parseScheduleB(text);
    requirements = parsed.requirements;
    exceptions = parsed.exceptions;
    console.log(`Parsed: ${requirements.length} requirements, ${exceptions.length} exceptions`);

    const xmlPath = join(tmpdir(), `commitment-${TARGET_ORDER}-${Date.now()}.xml`);
    try {
      writeFileSync(xmlPath, buildCommitmentXml(TARGET_ORDER, requirements, exceptions), "utf-8");
      console.log(`XML built. Starting Qualia session...`);

      await withSession(async (page) => {
        // Import commitment XML
        console.log(`  Importing commitment XML...`);
        await importXmlToQualia(page, order.qualia_id, xmlPath);
        console.log(`  Commitment imported.`);

        // Remove numbering from the header line in each section
        console.log(`  Fixing header numbering...`);
        await uncheckHeaderNumbering(page, order.qualia_id, "requirements");
        await uncheckHeaderNumbering(page, order.qualia_id, "exceptions");

        // Upload PDF to documents in the same session
        console.log(`  Uploading PDF to Documents...`);
        await uploadPdfToDocuments(page, order.qualia_id, pdfPath, TARGET_ORDER);
      }, { timeout: 3600 });
    } finally {
      try { unlinkSync(xmlPath); } catch {}
    }

    await removeLabel(emailId);
    await archiveEmail(emailId);
    console.log(`\n✓ Done — ${TARGET_ORDER} commitment imported and email archived.`);
  } finally {
    try { unlinkSync(pdfPath); } catch {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
