/**
 * Real send + close -- irreversible. Only run with explicit human
 * confirmation for the specific order passed in.
 * Usage: npx ts-node src/scripts/debug/run-send-and-close.ts <qualiaId> <address> [ownerEmailOverride] [owner,lender]
 */
import { withSession } from "../../browserbase";
import { sendTrailingDocuments } from "../../actions/send-trailing-documents";
import { closeOrder } from "../../actions/close-order";
import type { PolicyKind } from "../../actions/prepare-final-policy";

const qualiaId = process.argv[2];
const address = process.argv[3];
const ownerEmailOverride = process.argv[4] || undefined;
const policies = (process.argv[5] ?? "owner,lender").split(",") as PolicyKind[];

if (!qualiaId || !address) {
  console.error("Usage: npx ts-node src/scripts/debug/run-send-and-close.ts <qualiaId> <address> [ownerEmailOverride] [owner,lender]");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    console.log(`--- sendTrailingDocuments(${qualiaId}, real send) ---`);
    const sendResult = await sendTrailingDocuments(page, qualiaId!, address!, policies, { ownerEmailOverride });
    console.log(JSON.stringify(sendResult, null, 2));

    if (sendResult.status !== "sent") {
      console.log("Send failed -- not closing the order.");
      return;
    }

    console.log(`\n--- closeOrder(${qualiaId}) ---`);
    const closeResult = await closeOrder(page, qualiaId!);
    console.log(JSON.stringify(closeResult, null, 2));
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
