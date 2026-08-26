/**
 * Read-only check: does the order actually show status "Closed" now?
 * Usage: npx ts-node src/scripts/debug/verify-closed.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { navigateToOrder } from "../../utils/navigate";
import { dismissStartupModals } from "../../utils/dismiss-modals";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/verify-closed.ts <qualiaId>");
  process.exit(1);
}

async function main() {
  await withSession(async (page) => {
    await navigateToOrder(page, qualiaId!, "dashboard/summary");
    await dismissStartupModals(page);
    await page.waitForTimeout(3000);

    const status = await page.evaluate(`
      (function() {
        var candidates = [];
        document.querySelectorAll('div.text').forEach(function(el) {
          var t = (el.textContent || '').trim();
          if (t === 'Open' || t === 'Closed' || t === 'Cancelled') candidates.push(t);
        });
        return JSON.stringify(candidates);
      })()
    `);
    console.log("Status text found:", status);
  }, { timeout: 600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
