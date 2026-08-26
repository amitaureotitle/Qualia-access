/**
 * Real close-order only (email already sent separately). Irreversible-ish.
 * Usage: npx ts-node src/scripts/debug/run-close-order.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { closeOrder } from "../../actions/close-order";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/run-close-order.ts <qualiaId>");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    const result = await closeOrder(page, qualiaId!);
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
