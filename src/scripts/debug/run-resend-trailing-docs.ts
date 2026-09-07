/**
 * Resend trailing documents with a note prepended to the body -- does NOT
 * call closeOrder (for an order that's already closed from a first, bad
 * send). Defaults to a compose-only dry run; pass --live to actually send.
 *
 * Pass an ownerEmailOverride for ZMO-sourced orders -- check
 * config/policies/post_closing_recipients.json (Pipeline-dashboard repo)
 * for the company's designated mailbox FIRST. 2026-08-31: an earlier resend
 * skipped this and went to the on-order Buyer/Borrower Representative
 * contact instead of the agreed department mailbox.
 *
 * Usage: npx ts-node src/scripts/debug/run-resend-trailing-docs.ts <qualiaId> <address> <note> [owner,lender] [ownerEmailOverride] [--live]
 */
import { withSession } from "../../browserbase";
import { sendTrailingDocuments } from "../../actions/send-trailing-documents";
import type { PolicyKind } from "../../actions/prepare-final-policy";

const qualiaId = process.argv[2];
const address = process.argv[3];
const note = process.argv[4];
const policies = (process.argv[5] ?? "owner,lender").split(",") as PolicyKind[];
const ownerEmailOverride = process.argv[6] && !process.argv[6].startsWith("--") ? process.argv[6] : undefined;
const live = process.argv.includes("--live");

if (!qualiaId || !address || !note) {
  console.error("Usage: npx ts-node src/scripts/debug/run-resend-trailing-docs.ts <qualiaId> <address> <note> [owner,lender] [ownerEmailOverride] [--live]");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    console.log(`--- sendTrailingDocuments(${qualiaId}, ${live ? "REAL SEND" : "compose-only dry run"}, ownerEmailOverride=${ownerEmailOverride ?? "none"}) ---`);
    const result = await sendTrailingDocuments(page, qualiaId!, address!, policies, {
      note,
      ownerEmailOverride,
      composeOnly: !live,
    });
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 300 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
