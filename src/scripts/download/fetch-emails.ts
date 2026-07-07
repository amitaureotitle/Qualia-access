/**
 * Non-interactive discovery: fetch matching unread emails and search Qualia for each address.
 * Outputs a JSON summary so the AI assistant can present choices to the user.
 */
import { tmpdir } from "os";
import { join } from "path";
import { fetchMatchingEmails, saveAttachments } from "../../gmail";
import { withSession } from "../../browserbase";
import { searchOrders } from "../../utils/navigate";

const PATTERNS = [
  {
    name: "Docusign completed",
    subject: /^Completed: Please sign documents for /i,
    extractAddress: (s: string) =>
      s.match(/^Completed: Please sign documents for (.+)$/i)?.[1]?.trim() ?? null,
  },
];

function streetOnly(address: string): string {
  return address.replace(/\s+[A-Z]{2}$/, "").replace(/\s+\S+$/, "").trim() || address;
}

async function main() {
  const found: any[] = [];

  for (const pattern of PATTERNS) {
    const emails = await fetchMatchingEmails(pattern.subject);

    for (const email of emails) {
      const address = pattern.extractAddress(email.subject);
      if (!address) continue;

      const searchQuery = streetOnly(address);

      // Save attachments
      const tmpDir = join(tmpdir(), `qualia-email-${email.id}`);
      const filePaths = saveAttachments(email, tmpDir);

      // Search Qualia for matching orders
      let orders: { orderNumber: string; label: string }[] = [];
      await withSession(async (page) => {
        orders = await searchOrders(page, searchQuery);
      });

      found.push({
        emailId: email.id,
        subject: email.subject,
        from: email.from,
        address,
        searchQuery,
        attachments: email.attachments.map((a) => a.filename),
        savedFiles: filePaths,
        orders,
      });
    }
  }

  console.log(JSON.stringify(found, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
