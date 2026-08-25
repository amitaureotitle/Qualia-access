/**
 * Live dry-run of the post-closing check (read-only, no Issue click) against
 * a real order. Usage: npx ts-node src/scripts/debug/test-post-closing.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { verifyRecording } from "../../actions/verify-recording";
import { prepareFinalPolicy } from "../../actions/prepare-final-policy";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/test-post-closing.ts <qualiaId>");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    console.log(`\n--- verifyRecording(${qualiaId}) ---`);
    const recording = await verifyRecording(page, qualiaId!);
    console.log(JSON.stringify(recording, null, 2));

    if (!recording.recorded) {
      console.log("\nNot fully recorded yet -- stopping here (matches check-and-prepare's real behavior).");
      return;
    }

    console.log(`\n--- prepareFinalPolicy(${qualiaId}) ---`);
    const policy = await prepareFinalPolicy(page, qualiaId!);
    console.log(JSON.stringify(policy, null, 2));
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
