/**
 * Debug: test XML import with correct selectors.
 */
import { withSession } from "../../browserbase";
import { fetchOrderByNumber } from "../../utils/order-api";
import { dismissStartupModals } from "../../utils/dismiss-modals";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Page } from "playwright-core";
import dotenv from "dotenv";
dotenv.config();

const ORDER_NUMBER = "2026-MO-185";

function buildTestXml(orderNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CC_Export>
  <CC_File File_Number="${orderNumber}">
    <CCMASTER><FILENO Field_Type="C">${orderNumber}</FILENO></CCMASTER>
    <PROPERTY>
      <PFILENO Field_Type="C">${orderNumber}</PFILENO>
      <PARCEL>
        <FILENO Field_Type="C">${orderNumber}</FILENO>
        <TYPECODE Field_Type="C">CAR</TYPECODE>
        <TEXT Field_Type="M">          [#] The following are the requirements to be complied with:&lt;br&gt;

          [#] TEST REQUIREMENT — automated import check.</TEXT>
      </PARCEL>
      <PARCEL>
        <FILENO Field_Type="C">${orderNumber}</FILENO>
        <TYPECODE Field_Type="C">CE</TYPECODE>
        <TEXT Field_Type="M">          [#] Schedule B of the policy or policies to be issued will contain exceptions to the following matters unless the same are disposed of in accordance with underwriting guidelines:

          [#] TEST EXCEPTION — automated import check.</TEXT>
      </PARCEL>
    </PROPERTY>
  </CC_File>
</CC_Export>`;
}

async function main() {
  const order = await fetchOrderByNumber(ORDER_NUMBER);
  if (!order) throw new Error(`Order ${ORDER_NUMBER} not found`);
  console.log(`Order: ${ORDER_NUMBER} → ${order.qualia_id}`);

  const xmlPath = join(tmpdir(), `test-import-${Date.now()}.xml`);
  writeFileSync(xmlPath, buildTestXml(ORDER_NUMBER), "utf-8");

  try {
    await withSession(async (page: Page) => {
      await page.goto(
        `https://aureotitle.qualia.io/orders/${order.qualia_id}/title/commitment?section=requirements`,
        { waitUntil: 'domcontentloaded', timeout: 90000 }
      );
      await dismissStartupModals(page);
      await page.waitForTimeout(4000);

      // 1. Open Import from File popup (data-content, not title)
      await page.evaluate(`document.querySelector('uploadcommitment').click()`);
      await page.waitForTimeout(800);
      await page.screenshot({ path: '/tmp/s1-popup-opened.png' });
      console.log('Step 1: clicked uploadcommitment');

      // 2. Set XML file
      await page.setInputFiles('input[type="file"]', xmlPath);
      await page.waitForTimeout(1500);
      console.log('Step 2: file set');

      // 3. Click Title Provider dropdown
      await page.evaluate(`
        (function() {
          var input = document.querySelector('input[data-schema-key="titleServiceProvider"]');
          if (input) {
            var dd = input.closest('.ui.dropdown');
            if (dd) { dd.click(); console.log('clicked title provider dropdown'); }
            else console.log('no dropdown parent found');
          } else console.log('titleServiceProvider input not found');
        })()
      `);
      await page.waitForTimeout(400);

      // 4. Select First American
      await page.evaluate(`
        (function() {
          var item = document.querySelector('.item[data-value="First American"]');
          if (item) { item.click(); console.log('clicked First American'); }
          else console.log('First American item not found');
        })()
      `);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: '/tmp/s2-provider-selected.png' });
      console.log('Step 3+4: provider selected');

      // 5. Check submitcommitment state
      const btnState: string = await page.evaluate(`
        (function() {
          var b = document.querySelector('submitcommitment');
          if (!b) return 'not found';
          return b.className;
        })()
      `);
      console.log('submitcommitment classes:', btnState);

      // Wait for it to become enabled (up to 5s)
      await page.waitForFunction(
        `(function() { var b = document.querySelector('submitcommitment'); return b && !b.classList.contains('disabled'); })()`
        , { timeout: 5000 }
      ).catch(() => console.log('submitcommitment still disabled after 5s'));

      // 6. Click Import File (submitcommitment custom element)
      await page.evaluate(`
        (function() {
          var b = document.querySelector('submitcommitment');
          if (b) { b.click(); console.log('clicked submitcommitment'); }
          else console.log('submitcommitment not found');
        })()
      `);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: '/tmp/s3-after-import-file.png' });
      console.log('Step 5: clicked Import File');

      // 7. Handle Confirm Import popup — dump what appeared
      const confirmInfo: string = await page.evaluate(`
        (function() {
          // Look for modal, dimmer, or any element containing "Confirm Import"
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].children.length > 0) continue;
            if (all[i].textContent.trim() === 'Confirm Import') {
              var p = all[i].parentElement;
              return p ? p.parentElement ? p.parentElement.outerHTML.slice(0, 1500) : p.outerHTML.slice(0, 1500) : 'no parent';
            }
          }
          return 'Confirm Import text not found';
        })()
      `);
      console.log('Confirm Import container:', confirmInfo);

      // Try clicking any "Import" button that's visible
      const confirmResult: string = await page.evaluate(`
        (function() {
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.children.length === 0 && el.textContent.trim() === 'Import' && el.offsetParent !== null) {
              el.click();
              return 'clicked: ' + el.tagName + '.' + el.className;
            }
          }
          // Try parent elements with text Import
          var btns = document.querySelectorAll('button, .ui.button');
          for (var j = 0; j < btns.length; j++) {
            var t = btns[j].textContent.trim();
            if (t === 'Import' && btns[j].offsetParent !== null) {
              btns[j].click();
              return 'clicked button: ' + btns[j].tagName + '.' + btns[j].className;
            }
          }
          return 'Import button not found';
        })()
      `);
      console.log('Confirm click result:', confirmResult);

      await page.waitForTimeout(6000);
      await page.screenshot({ path: '/tmp/s4-done.png' });
      console.log('Done. Check screenshots in /tmp/s*.png');

    }, { timeout: 3600 });
  } finally {
    try { unlinkSync(xmlPath); } catch {}
  }
}

main().catch(console.error);
