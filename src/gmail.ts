import { google } from "googleapis";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";

dotenv.config();

const SERVICE_ACCOUNT_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const GMAIL_USER = process.env.GMAIL_USER ?? "amit@aureotitle.com";

if (!SERVICE_ACCOUNT_KEY_FILE) {
  throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required");
}

function buildGmailClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: GMAIL_USER },
  });
  return google.gmail({ version: "v1", auth });
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MatchedEmail {
  id: string;
  subject: string;
  from: string;
  attachments: EmailAttachment[];
}

/** Return messages whose subject matches the given pattern. */
export async function fetchMatchingEmails(
  subjectPattern: RegExp | string,
  opts: { markRead?: boolean; unreadOnly?: boolean } = {}
): Promise<MatchedEmail[]> {
  const gmail = buildGmailClient();

  const subjectQuery =
    typeof subjectPattern === "string"
      ? `subject:"${subjectPattern}"`
      : `subject:(${subjectPattern.source})`;
  const unreadFilter = opts.unreadOnly === false ? "" : "is:unread ";
  const q = `${unreadFilter}${subjectQuery}`;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 50,
  });

  const messages = listRes.data.messages ?? [];
  const results: MatchedEmail[] = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "full",
    });

    const payload = full.data.payload;
    const headers = payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";

    // Double-check subject matches (in case Gmail query was fuzzy)
    const matches =
      typeof subjectPattern === "string"
        ? subject.toLowerCase().includes(subjectPattern.toLowerCase())
        : subjectPattern.test(subject);

    if (!matches) continue;

    const attachments = await extractAttachments(gmail, msg.id!, payload);

    results.push({ id: msg.id!, subject, from, attachments });

    if (opts.markRead) {
      await gmail.users.messages.modify({
        userId: "me",
        id: msg.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    }
  }

  return results;
}

async function extractAttachments(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  payload: any
): Promise<EmailAttachment[]> {
  const attachments: EmailAttachment[] = [];

  async function walk(part: any) {
    if (!part) return;

    const filename = part.filename as string | undefined;
    const body = part.body as { attachmentId?: string; data?: string; size?: number } | undefined;

    if (filename && body?.attachmentId) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: body.attachmentId,
      });
      const data = Buffer.from(res.data.data ?? "", "base64url");
      attachments.push({ filename, mimeType: part.mimeType ?? "application/octet-stream", data });
    } else if (body?.data && filename) {
      // Inline attachment with data already in the part
      const data = Buffer.from(body.data, "base64url");
      attachments.push({ filename, mimeType: part.mimeType ?? "application/octet-stream", data });
    }

    for (const subPart of part.parts ?? []) {
      await walk(subPart);
    }
  }

  await walk(payload);
  return attachments;
}

/** Mark an email as read and remove it from the inbox (archive). */
export async function archiveEmail(messageId: string): Promise<void> {
  const gmail = buildGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD", "INBOX"] },
  });
}

/**
 * Save attachments from a MatchedEmail to a temp directory.
 * Returns the list of absolute file paths.
 */
export function saveAttachments(email: MatchedEmail, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const att of email.attachments) {
    const dest = join(dir, att.filename);
    writeFileSync(dest, att.data);
    paths.push(dest);
  }
  return paths;
}
