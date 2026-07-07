import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!,
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  clientOptions: { subject: process.env.GMAIL_USER ?? "amit@aureotitle.com" },
});
const gmail = google.gmail({ version: "v1", auth });

async function main() {
  const list = await gmail.users.messages.list({ userId: "me", q: "dunmore", maxResults: 10 });
  const messages = list.data.messages ?? [];
  console.log(`Found ${messages.length} message(s)\n`);
  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id!, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
    const h = (name: string) => full.data.payload?.headers?.find(x => x.name?.toLowerCase() === name)?.value ?? "";
    const labels = full.data.labelIds ?? [];
    const unread = labels.includes("UNREAD") ? "[UNREAD]" : "[read]";
    const inInbox = labels.includes("INBOX") ? "[INBOX]" : "[archived]";
    console.log(`ID: ${msg.id}`);
    console.log(`${unread} ${inInbox}`);
    console.log(`Subject: ${h("subject")}`);
    console.log(`From: ${h("from")}`);
    console.log(`Date: ${h("date")}`);
    console.log();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
