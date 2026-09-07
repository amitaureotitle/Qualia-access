import { withSession } from "../../browserbase";
import { dismissStartupModals } from "../../utils/dismiss-modals";
import dotenv from "dotenv";
dotenv.config();

const QUALIA_ID = "3yngBCkP3tSwKvXtp"; // MO-239

async function main() {
  await withSession(async (page) => {
    await page.goto(
      `https://aureotitle.qualia.io/orders/${QUALIA_ID}/title/commitment?section=requirements`,
      { waitUntil: "domcontentloaded", timeout: 90000 }
    );
    await dismissStartupModals(page);
    await page.waitForTimeout(4000);

    const html: string = await page.evaluate(`
      (function() {
        var c = document.querySelector('conditions');
        if (!c || !c.children[0]) return 'no conditions';
        return c.children[0].outerHTML.slice(0, 3000);
      })()
    `);
    console.log("FIRST CONDITION HTML:\n", html);

    const clickResult: string = await page.evaluate(`
      (function() {
        var c = document.querySelector('conditions');
        if (!c || !c.children[0]) return 'no conditions';
        var first = c.children[0];
        var textEl = first.querySelector('conditiontext, [contenteditable], .condition-text');
        if (textEl) { textEl.click(); return 'clicked: ' + textEl.tagName + ' ' + (textEl.className||''); }
        first.click();
        return 'clicked row: ' + first.tagName;
      })()
    `);
    console.log("CLICK:", clickResult);
    await page.waitForTimeout(1000);

    const buttons: string = await page.evaluate(`
      (function() {
        var found = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.offsetParent === null) continue;
          var dc = el.getAttribute('data-content') || '';
          var tt = el.getAttribute('title') || '';
          var tag = el.tagName.toLowerCase();
          if (dc || tt || tag.includes('condition')) {
            found.push(tag + '  dc="' + dc + '"  title="' + tt + '"  cls="' + (el.className||'').slice(0,60) + '"');
          }
        }
        return found.join('\\n');
      })()
    `);
    console.log("VISIBLE AFTER CLICK:\n", buttons);
  }, { timeout: 3600 });
}
main().catch(console.error);
