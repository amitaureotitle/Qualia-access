import { tmpdir } from "os";
import { join } from "path";
import { google } from "googleapis";
import { fetchMatchingEmails, saveAttachments } from "../../gmail";
import { withSession } from "../../browserbase";
import { uploadDocument } from "../../actions/upload-document";
import { resolveOrderId } from "../../utils/navigate";

/**
 * A rule maps an email subject pattern to a Qualia action.
 * Add entries here as new workflows are needed.
 */
export interface EmailRule {
  /** Pattern to match against the email subject (string = includes, RegExp = test) */
  subject: RegExp | string;
  /** Given a matched email subject, return the Qualia order number (e.g. "2026-MO-131") */
  extractOrderNumber: (subject: string) => string | null;
  /** Optional document name override; defaults to the attachment filename */
  documentName?: (subject: string, filename: string) => string | undefined;
}

async function markEmailRead(messageId: string): Promise<void> {
  const SERVICE_ACCOUNT_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE!;
  const GMAIL_USER = process.env.GMAIL_USER ?? "amit@aureotitle.com";
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    clientOptions: { subject: GMAIL_USER },
  });
  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}

/**
 * Add your subject-line rules here.
 * Example: { subject: /Wire.*2026-MO-\d+/, extractOrderNumber: s => s.match(/2026-MO-\d+/)?.[0] ?? null }
 */
export const EMAIL_RULES: EmailRule[] = [
  // TODO: add rules as workflows are defined
];

/**
 * Process all unread emails that match any registered rule.
 * Downloads attachments, uploads them to the correct Qualia order, marks email as read.
 */
export async function processInbox(): Promise<void> {
  for (const rule of EMAIL_RULES) {
    const emails = await fetchMatchingEmails(rule.subject, { markRead: false });

    for (const email of emails) {
      const orderNumber = rule.extractOrderNumber(email.subject);
      if (!orderNumber) {
        console.warn(`[skip] Could not extract order number from: "${email.subject}"`);
        continue;
      }

      if (email.attachments.length === 0) {
        console.warn(`[skip] No attachments in email: "${email.subject}"`);
        continue;
      }

      console.log(`Processing email "${email.subject}" → order ${orderNumber}`);

      // Save attachments to a temp directory
      const tmpDir = join(tmpdir(), `qualia-${Date.now()}`);
      const filePaths = saveAttachments(email, tmpDir);

      await withSession(async (page) => {
        const orderId = await resolveOrderId(page, orderNumber);

        for (const filePath of filePaths) {
          const filename = filePath.split("/").pop()!;
          const name = rule.documentName?.(email.subject, filename);
          console.log(`  Uploading ${filename} to order ${orderNumber} (${orderId})`);
          await uploadDocument(page, orderId, filePath, name ? { name } : {});
          console.log(`  Done.`);
        }
      });

      // Mark as read only after successful upload
      await markEmailRead(email.id);
    }
  }
}
