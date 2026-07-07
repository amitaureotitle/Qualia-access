/**
 * Fetch and inspect the body of a specific email by subject pattern.
 * Usage: npx ts-node src/scripts/debug/inspect-email.ts
 */
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const SERVICE_ACCOUNT_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!;
const GMAIL_USER = process.env.GMAIL_USER ?? "amit@aureotitle.com";

function buildGmailClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: GMAIL_USER },
  });
  return google.gmail({ version: "v1", auth });
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractText(part: any): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  return "";
}

async function main() {
  const gmail = buildGmailClient();

  const list = await gmail.users.messages.list({
    userId: "me",
    q: 'subject:"Complete with Docusign"',
    maxResults: 5,
  });

  const messages = list.data.messages ?? [];
  console.log(`Found ${messages.length} message(s)\n`);

  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id!, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
    const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value ?? "";

    const body = extractText(full.data.payload).slice(0, 2000);

    // List attachment names
    const attachments: string[] = [];
    function walkParts(part: any) {
      if (part.filename) attachments.push(part.filename);
      for (const p of part.parts ?? []) walkParts(p);
    }
    walkParts(full.data.payload);

    console.log(`Subject: ${subject}`);
    console.log(`From:    ${from}`);
    console.log(`Date:    ${date}`);
    console.log(`Attachments: ${attachments.join(", ") || "(none)"}`);
    console.log(`\nBody:\n${body}`);
    console.log("\n" + "─".repeat(80) + "\n");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
