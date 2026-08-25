/**
 * Read-only check: did the policies actually get marked issued in Qualia?
 * Usage: npx ts-node src/scripts/debug/verify-issued.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { navigateToOrder } from "../../utils/navigate";
import { dismissStartupModals } from "../../utils/dismiss-modals";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/verify-issued.ts <qualiaId>");
  process.exit(1);
}

const SCRIPT = `
(function() {
  var issueAllBtn = document.querySelector('issueallpolicies');
  var issueBtns = Array.from(document.querySelectorAll('issuepolicy'));
  var bodyText = document.body.innerText;
  var issuedMatches = [];
  var re = /issued[^\\n]{0,40}/gi;
  var m;
  while ((m = re.exec(bodyText)) !== null) issuedMatches.push(m[0]);
  return JSON.stringify({
    issueAllPoliciesPresent: !!issueAllBtn,
    issueAllPoliciesText: issueAllBtn ? issueAllBtn.textContent.trim() : null,
    issueButtonCount: issueBtns.length,
    issueButtonTexts: issueBtns.map(function(b) { return b.textContent.trim(); }),
    issuedTextMatches: issuedMatches.slice(0, 10)
  });
})()
`;

async function main() {
  await withSession(async (page) => {
    await navigateToOrder(page, qualiaId!, "title/final_policy");
    await dismissStartupModals(page);
    await page.waitForTimeout(3000);
    const info = await page.evaluate(SCRIPT);
    console.log(info);
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
