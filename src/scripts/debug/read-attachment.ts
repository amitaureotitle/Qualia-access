import { google } from "googleapis";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
import dotenv from "dotenv";
dotenv.config();

const MESSAGE_ID = "19e6ad54b4f9bb36";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  const gmail = google.gmail({ version: "v1", auth });
  const full = await gmail.users.messages.get({ userId: "me", id: MESSAGE_ID, format: "full" });
  const headers = full.data.payload?.headers ?? [];
  const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
  console.log(`Subject: ${subject}\n`);

  const dir = join(tmpdir(), `qualia-email-${MESSAGE_ID}`);
  mkdirSync(dir, { recursive: true });

  async function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      const res = await gmail.users.messages.attachments.get({ userId: "me", messageId: MESSAGE_ID, id: part.body.attachmentId });
      const data = Buffer.from(res.data.data ?? "", "base64url");
      const dest = join(dir, part.filename);
      writeFileSync(dest, data);
      console.log(`=== ${part.filename} ===`);
      try {
        const parsed = await pdfParse(data);
        console.log(parsed.text.trim());
      } catch {
        console.log("(could not parse PDF text)");
      }
      console.log();
    }
    for (const p of part.parts ?? []) await walk(p);
  }
  await walk(full.data.payload);
}

main().catch(err => { console.error(err); process.exit(1); });
