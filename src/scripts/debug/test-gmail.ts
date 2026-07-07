import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const SERVICE_ACCOUNT_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!;
const GMAIL_USER = process.env.GMAIL_USER ?? "amit@aureotitle.com";

async function main() {
  console.log(`Testing Gmail access for ${GMAIL_USER}...`);

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: GMAIL_USER },
  });

  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  console.log(`Connected! Email: ${profile.data.emailAddress}`);
  console.log(`Total messages: ${profile.data.messagesTotal}`);
  console.log(`Unread: ${profile.data.threadsTotal}`);

  // List 5 most recent unread messages
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: 5,
  });

  const msgs = list.data.messages ?? [];
  console.log(`\nMost recent unread messages (up to 5):`);
  for (const msg of msgs) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    const h = (name: string) =>
      full.data.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
    console.log(`  [${h("Date")}] ${h("Subject")} — from: ${h("From")}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
