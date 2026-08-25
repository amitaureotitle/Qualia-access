/**
 * Live test of the actual "Issue" click -- irreversible, only run with
 * explicit human confirmation for the specific order passed in.
 * Usage: npx ts-node src/scripts/debug/test-issue-policies.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { verifyRecording } from "../../actions/verify-recording";
import { prepareFinalPolicy } from "../../actions/prepare-final-policy";
import { issueFinalPolicies } from "../../actions/issue-final-policies";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/test-issue-policies.ts <qualiaId>");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    console.log(`\n--- re-verifying ${qualiaId} is still ready ---`);
    const recording = await verifyRecording(page, qualiaId!);
    if (!recording.recorded) {
      console.log("Not recorded -- aborting.", recording);
      return;
    }
    const prep = await prepareFinalPolicy(page, qualiaId!);
    console.log(JSON.stringify(prep, null, 2));
    if (prep.status !== "ready") {
      console.log("Not ready -- aborting.");
      return;
    }

    console.log(`\n--- issueFinalPolicies(${qualiaId}, ${JSON.stringify(prep.policies)}) ---`);
    const result = await issueFinalPolicies(page, qualiaId!, prep.policies);
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
