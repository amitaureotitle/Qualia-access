/**
 * Match a pending Zoom EMD wire to an order via matchEmdWire(). Unlike
 * run-send-and-close.ts, this defaults to composeOnly (dry run) -- pass
 * --live as a fourth arg to actually click "Send To Order" for real. This
 * extra safety rail is deliberate: matching creates a real transaction
 * against real escrow money, and match-emd-wire.ts's own selectors have
 * never been exercised past the dry-run point (see its doc comment).
 *
 * Usage: npx ts-node src/scripts/debug/run-match-emd-wire.ts <orderNumber> <fedwireNumber> <expectedAddress> [--live]
 */
import { withSession } from "../../browserbase";
import { matchEmdWire } from "../../actions/match-emd-wire";

const orderNumber = process.argv[2];
const fedwireNumber = process.argv[3];
const expectedAddress = process.argv[4];
const live = process.argv.includes("--live");

if (!orderNumber || !fedwireNumber || !expectedAddress) {
  console.error(
    "Usage: npx ts-node src/scripts/debug/run-match-emd-wire.ts <orderNumber> <fedwireNumber> <expectedAddress> [--live]"
  );
  process.exit(1);
}

async function main() {
  console.log(`--- matchEmdWire(${orderNumber}, ${fedwireNumber}, composeOnly=${!live}) ---`);
  const result = await withSession(
    (page) => matchEmdWire(page, orderNumber!, fedwireNumber!, expectedAddress!, { composeOnly: !live }),
    { timeout: 300 }
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
