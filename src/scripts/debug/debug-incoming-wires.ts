import { withSession } from "../../browserbase";
import dotenv from "dotenv";
dotenv.config();

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

async function main() {
  await withSession(
    async (page) => {
      // Confirmed live 2026-08-27: the /accounting/<slug>/... slug is each
      // bank account's own stable Qualia ID (its <swapbank data-value="...">
      // in the account-switcher dropdown), not a per-session token -- e.g.
      // Axos Trust Account is always "TgTSZFSEsWr388MbF". Navigate straight
      // there instead of clicking through the account switcher.
      const AXOS_TRUST_ACCOUNT_ID = process.env.QUALIA_TRUST_ACCOUNT_ID || "TgTSZFSEsWr388MbF";
      await page.goto(new URL(`/accounting/${AXOS_TRUST_ACCOUNT_ID}/incoming_wires`, BASE_URL).href, {
        waitUntil: "domcontentloaded",
      });
      console.log("Final URL:", page.url());
      await page.waitForTimeout(2000);

      await page.screenshot({ path: "debug-incoming-wires.png", fullPage: true });

      // Dump the pending wires rows (scoped, not the whole page)
      const rows: string = await page.evaluate(`
        (function() {
          var out = [];
          document.querySelectorAll('table tr, .table tr').forEach(function(tr) {
            var t = (tr.textContent || '').replace(/\\s+/g, ' ').trim();
            if (t) out.push(t);
          });
          return JSON.stringify(out);
        })()
      `);
      console.log("Pending rows (table selector):", rows);

      if (rows === "[]") {
        const bodyDump: string = await page.evaluate(`document.body.innerText.slice(0, 3000)`);
        console.log("Body innerText:", bodyDump);
        const tagCounts: string = await page.evaluate(`
          (function() {
            var counts = {};
            document.querySelectorAll('*').forEach(function(el) {
              var tag = el.tagName.toLowerCase();
              counts[tag] = (counts[tag] || 0) + 1;
            });
            return JSON.stringify(counts);
          })()
        `);
        console.log("Tag counts:", tagCounts);
      }

      const TARGET_FEDWIRE = process.argv[2] || "";
      if (TARGET_FEDWIRE) {
        const clickResult: string = await page.evaluate(`
          (function() {
            var rows = document.querySelectorAll('table tr, .table tr');
            for (var i = 0; i < rows.length; i++) {
              var tr = rows[i];
              if ((tr.textContent || '').indexOf(${JSON.stringify(TARGET_FEDWIRE)}) === -1) continue;
              var links = tr.querySelectorAll('a');
              for (var j = 0; j < links.length; j++) {
                if ((links[j].textContent || '').trim() === 'Match') { links[j].click(); return 'clicked'; }
              }
              return 'row found, no Match link';
            }
            return 'row not found for fedwire ' + ${JSON.stringify(TARGET_FEDWIRE)};
          })()
        `);
        console.log("Match click:", clickResult);

        if (clickResult === "clicked") {
          await page.waitForTimeout(2000);
          await page.screenshot({ path: "debug-match-modal.png", fullPage: true });

          const findModal: string = await page.evaluate(`
            (function() {
              var all = document.querySelectorAll('*');
              var candidates = [];
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (el.children.length > 0 && el.offsetParent !== null &&
                    (el.textContent || '').indexOf('Match and Resolve Wire') !== -1) {
                  candidates.push(el.tagName.toLowerCase() + '.' + el.className);
                }
              }
              return JSON.stringify(candidates.slice(0, 15));
            })()
          `);
          console.log("Modal candidates:", findModal);

          const modalDump: string = await page.evaluate(`
            (function() {
              var modal = document.querySelector('globalmodal.active, globalmodal');
              if (!modal) return 'globalmodal not found';
              var out = { tabs: [], inputs: [], buttons: [], text: (modal.textContent||'').replace(/\\s+/g,' ').trim().slice(0,1500) };
              modal.querySelectorAll('[role="tab"], .item, .tab').forEach(function(el) {
                var t = (el.textContent || '').trim();
                if (t && t.length < 40) out.tabs.push(t);
              });
              modal.querySelectorAll('input').forEach(function(el) {
                out.inputs.push({ name: el.name, placeholder: el.placeholder, value: el.value, cls: el.className, tag: el.tagName });
              });
              modal.querySelectorAll('button, .button').forEach(function(el) {
                var t = (el.textContent || '').trim();
                if (t) out.buttons.push(t);
              });
              return JSON.stringify(out, null, 2);
            })()
          `);
          console.log("Modal dump:", modalDump);

          const TARGET_ORDER = process.argv[3] || "";
          if (TARGET_ORDER) {
            const searchInput = page.locator('globalmodal input[placeholder="Search orders..."]');
            await searchInput.fill(TARGET_ORDER);
            await page.waitForTimeout(2000);

            const afterType: string = await page.evaluate(`
              (function() {
                var modal = document.querySelector('globalmodal.active, globalmodal');
                if (!modal) return 'globalmodal not found';
                var results = [];
                modal.querySelectorAll('.results .result, .menu .item').forEach(function(el) {
                  var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
                  if (t) results.push(t);
                });
                return JSON.stringify({ dropdownResults: results.slice(0, 10) });
              })()
            `);
            console.log("After typing order number:", afterType);

            // Click the matching dropdown result if present (still not
            // clicking Send To Order -- that's the real destructive step).
            const pickOrderResult: string = await page.evaluate(`
              (function() {
                var modal = document.querySelector('globalmodal.active, globalmodal');
                var items = modal.querySelectorAll('.results .result, .menu .item');
                for (var i = 0; i < items.length; i++) {
                  var t = (items[i].textContent || '');
                  if (t.indexOf(${JSON.stringify(TARGET_ORDER)}) !== -1) { items[i].click(); return 'clicked: ' + t.trim(); }
                }
                return 'no matching dropdown item for ' + ${JSON.stringify(TARGET_ORDER)};
              })()
            `);
            console.log("Pick order result:", pickOrderResult);
            await page.waitForTimeout(1500);

            const criteriaDump: string = await page.evaluate(`
              (function() {
                var modal = document.querySelector('globalmodal.active, globalmodal');
                var text = (modal.textContent || '').replace(/\\s+/g, ' ').trim();
                var idx = text.indexOf('Enter Order Criteria');
                return text.slice(idx, idx + 600);
              })()
            `);
            console.log("Order criteria section:", criteriaDump);

            await page.screenshot({ path: "debug-match-modal-filled.png", fullPage: true });

            const buttonDetails: string = await page.evaluate(`
              (function() {
                var modal = document.querySelector('globalmodal.active, globalmodal');
                var out = [];
                modal.querySelectorAll('button, .button').forEach(function(el) {
                  var t = (el.textContent || '').trim();
                  if (t === 'Send To Order') {
                    out.push({ tag: el.tagName, cls: el.className, parentTag: el.parentElement ? el.parentElement.tagName : null, parentCls: el.parentElement ? el.parentElement.className : null });
                  }
                });
                return JSON.stringify(out, null, 2);
              })()
            `);
            console.log("Send To Order button details:", buttonDetails);
          }
        }
      }
    },
    { contextId: process.env.QUALIA_CONTEXT_ID }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
