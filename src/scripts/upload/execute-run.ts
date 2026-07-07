import { google } from "googleapis";
import { withSession } from "../../browserbase";
import { resolveOrderId } from "../../utils/navigate";
import { uploadDocument } from "../../actions/upload-document";
import { archiveEmail } from "../../gmail";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dotenv from "dotenv";
dotenv.config();

async function fetchAttachments(messageId: string): Promise<{ subject: string; filePaths: string[] }> {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
  });
  const gmail = google.gmail({ version: "v1", auth });
  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = full.data.payload?.headers ?? [];
  const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
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
  return { subject, filePaths };
}

const ACTIONS = [
  { emailId: "19e6a09a8c5e21af", label: "607 Jasmin Dr",          orders: ["2026-MO-175", "2026-MO-181"] },
  { emailId: "19e69ee0b7510f91", label: "2314 N Capitol Ave (2nd)", orders: ["2026-IN-149", "2026-IN-143"] },
];

async function main() {
  for (const action of ACTIONS) {
    console.log(`\nFetching: ${action.label}`);
    const { subject, filePaths } = await fetchAttachments(action.emailId);
    console.log(`  Files: ${filePaths.map(f => f.split("/").pop()).join(", ")}`);

    await withSession(async (page) => {
      for (const orderNumber of action.orders) {
        console.log(`  → ${orderNumber}`);
        const internalId = await resolveOrderId(page, orderNumber);
        for (const filePath of filePaths) {
          await uploadDocument(page, internalId, filePath);
          console.log(`    ✓ ${filePath.split("/").pop()}`);
        }
      }
    });

    await archiveEmail(action.emailId);
    console.log(`  ✓ Archived`);
  }
  console.log("\nAll done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
