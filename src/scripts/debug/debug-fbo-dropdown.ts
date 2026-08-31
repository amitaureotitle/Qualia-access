import { withSession } from "../../browserbase";

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";
const TRUST_ACCOUNT_ID = process.env.QUALIA_TRUST_ACCOUNT_ID || "TgTSZFSEsWr388MbF";
const fedwireNumber = process.argv[2];

if (!fedwireNumber) {
  console.error("Usage: npx ts-node src/scripts/debug/debug-fbo-dropdown.ts <fedwireNumber>");
  process.exit(1);
}

async function main() {
  await withSession(
    async (page) => {
      await page.goto(new URL(`/accounting/${TRUST_ACCOUNT_ID}/incoming_wires`, BASE_URL).href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2000);

      const clickResult: string = await page.evaluate(`
        (function() {
          var rows = document.querySelectorAll('table tr');
          for (var i = 0; i < rows.length; i++) {
            var tr = rows[i];
            if ((tr.textContent || '').indexOf(${JSON.stringify(fedwireNumber)}) === -1) continue;
            var links = tr.querySelectorAll('a');
            for (var j = 0; j < links.length; j++) {
              if ((links[j].textContent || '').trim() === 'Match') { links[j].click(); return 'clicked'; }
            }
            return 'row found, no Match link';
          }
          return 'not found';
        })()
      `);
      console.log("Match click:", clickResult);
      if (clickResult !== "clicked") return;

      await page.locator("globalmodal.active").first().waitFor({ state: "attached", timeout: 15_000 });
      await page.waitForTimeout(1500);

      // Click the first "Suggested Orders" Select button just to populate
      // the criteria form -- doesn't matter which order, purely for
      // inspecting the FBO field's DOM shape. Never clicking finish.
      const selectResult: string = await page.evaluate(`
        (function() {
          var modal = document.querySelector('globalmodal.active');
          var buttons = modal.querySelectorAll('button, .button, a');
          for (var i = 0; i < buttons.length; i++) {
            if ((buttons[i].textContent || '').trim() === 'Select') { buttons[i].click(); return 'clicked'; }
          }
          return 'no Select button found';
        })()
      `);
      console.log("Select suggested order:", selectResult);
      await page.waitForTimeout(1500);

      // Dump the "Funds For Benefit Of" field's dropdown HTML specifically.
      const fboHtml: string = await page.evaluate(`
        (function() {
          var modal = document.querySelector('globalmodal.active');
          var all = modal.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length > 0) continue;
            var txt = (el.textContent || '').trim().toLowerCase();
            if (txt.indexOf('funds for benefit of') !== -1) {
              var container = el.closest ? (el.closest('.field') || el.closest('.fields')) : null;
              return 'label found: "' + el.textContent.trim() + '" tag=' + el.tagName +
                ' | container: ' + (container ? container.outerHTML.slice(0, 3000) : 'no .field ancestor, parent: ' + (el.parentElement ? el.parentElement.outerHTML.slice(0,2000) : 'none'));
            }
          }
          return 'not found. Full modal text: ' + (modal.textContent||'').replace(/\\s+/g,' ').trim().slice(0,1000);
        })()
      `);
      console.log("FBO field HTML:", fboHtml);
    },
    { contextId: process.env.QUALIA_CONTEXT_ID, timeout: 300 }
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
