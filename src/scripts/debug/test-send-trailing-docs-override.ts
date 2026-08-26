/**
 * Compose-only dry run of sendTrailingDocuments with an owner email
 * override -- never clicks Send.
 * Usage: npx ts-node src/scripts/debug/test-send-trailing-docs-override.ts <qualiaId> <address> <ownerEmail> owner,lender
 */
import { withSession } from "../../browserbase";
import { sendTrailingDocuments } from "../../actions/send-trailing-documents";
import type { PolicyKind } from "../../actions/prepare-final-policy";

const qualiaId = process.argv[2];
const address = process.argv[3];
const ownerEmailOverride = process.argv[4];
const policies = (process.argv[5] ?? "owner,lender").split(",") as PolicyKind[];

if (!qualiaId || !address || !ownerEmailOverride) {
  console.error("Usage: npx ts-node src/scripts/debug/test-send-trailing-docs-override.ts <qualiaId> <address> <ownerEmail> [owner,lender]");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    const result = await sendTrailingDocuments(page, qualiaId!, address!, policies, {
      composeOnly: true,
      ownerEmailOverride,
    });
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
