/**
 * Resend trailing documents with a note prepended to the body -- does NOT
 * call closeOrder (for an order that's already closed from a first, bad
 * send). Defaults to a compose-only dry run; pass --live to actually send.
 * Usage: npx ts-node src/scripts/debug/run-resend-trailing-docs.ts <qualiaId> <address> <note> [owner,lender] [--live]
 */
import { withSession } from "../../browserbase";
import { sendTrailingDocuments } from "../../actions/send-trailing-documents";
import type { PolicyKind } from "../../actions/prepare-final-policy";

const qualiaId = process.argv[2];
const address = process.argv[3];
const note = process.argv[4];
const policies = (process.argv[5] ?? "owner,lender").split(",") as PolicyKind[];
const live = process.argv.includes("--live");

if (!qualiaId || !address || !note) {
  console.error("Usage: npx ts-node src/scripts/debug/run-resend-trailing-docs.ts <qualiaId> <address> <note> [owner,lender] [--live]");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    console.log(`--- sendTrailingDocuments(${qualiaId}, ${live ? "REAL SEND" : "compose-only dry run"}) ---`);
    const result = await sendTrailingDocuments(page, qualiaId!, address!, policies, {
      note,
      composeOnly: !live,
    });
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 300 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
