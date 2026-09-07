import { withSession } from '../../browserbase';
import { dismissStartupModals } from '../../utils/dismiss-modals';
import { writeFileSync, readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await withSession(async (page) => {
    await page.goto('https://aureotitle.qualia.io/orders/AybPcZcus34MHwi38/title/commitment?section=requirements');
    await dismissStartupModals(page);
    await page.waitForTimeout(4000);

    // Patch URL.createObjectURL to capture blob URLs synchronously
    await page.evaluate(`
      (function() {
        var orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = function(blob) {
          var url = orig(blob);
          window.__blobUrls = (window.__blobUrls || []).concat(url);
          console.log('[patch] createObjectURL called, url:', url, 'size:', blob.size);
          return url;
        };
      })()
    `);

    // Open Export XML modal
    await page.evaluate(`
      (function() {
        var btns = document.querySelectorAll('.ui.basic.icon.button');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('title') === 'Export XML') { btns[i].click(); return; }
        }
      })()
    `);
    await page.waitForTimeout(1000);

    // Open format dropdown
    await page.evaluate(`
      (function() {
        var f = document.querySelector('#SchemaForm_6');
        if (f) { var dd = f.querySelector('.ui.dropdown'); if (dd) dd.click(); }
      })()
    `);
    await page.waitForTimeout(400);

    // Select Ramquest
    await page.evaluate(`
      (function() {
        var f = document.querySelector('#SchemaForm_6');
        if (f) { var it = f.querySelector('.item[data-value="Ramquest"]'); if (it) it.click(); }
      })()
    `);
    await page.waitForTimeout(500);

    // Set up download listener and click export simultaneously
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);

    await page.evaluate(`
      (function() {
        var b = document.querySelector('#SchemaForm_6 export');
        if (b) { console.log('clicking export'); b.click(); }
        else { console.log('no export button found'); }
      })()
    `);

    // Wait for either download event or blob URL to appear
    await page.waitForTimeout(4000);

    // Try 1: Playwright download event
    const dl = await downloadPromise;
    if (dl) {
      console.log('Got download event! filename:', dl.suggestedFilename());
      try {
        const filePath = await dl.path();
        console.log('Download path:', filePath);
        if (filePath) {
          const xml = readFileSync(filePath, 'utf-8');
          writeFileSync('/tmp/qualia-export.xml', xml);
          console.log('Saved via download.path()! Preview:', xml.slice(0, 500));
        }
      } catch (e) {
        console.log('path() failed:', e);
        try {
          const stream = await dl.createReadStream();
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', resolve);
            stream.on('error', reject);
          });
          const xml = Buffer.concat(chunks).toString('utf-8');
          writeFileSync('/tmp/qualia-export.xml', xml);
          console.log('Saved via createReadStream! Preview:', xml.slice(0, 500));
        } catch (e2) {
          console.log('createReadStream failed:', e2);
        }
      }
      return;
    }

    console.log('No download event — trying blob URL fetch...');

    // Try 2: fetch blob URL from within page context (blob URLs are valid in the same page)
    const blobUrls: string[] = await page.evaluate(`window.__blobUrls || []`);
    console.log('Blob URLs captured:', blobUrls);

    if (blobUrls.length > 0) {
      const lastUrl = blobUrls[blobUrls.length - 1]!;
      const content: string = await page.evaluate(`
        (function() {
          return fetch(${JSON.stringify(lastUrl)})
            .then(function(r) { return r.text(); })
            .catch(function(e) { return 'fetch error: ' + String(e); });
        })()
      `);
      console.log('Blob content (first 500):', content.slice(0, 500));
      if (content.length > 50 && !content.startsWith('fetch error')) {
        writeFileSync('/tmp/qualia-export.xml', content);
        console.log('Saved to /tmp/qualia-export.xml');
      }
    } else {
      console.log('No blob URLs captured — checking DOM for download links.');
      await page.screenshot({ path: '/tmp/export-state.png' });
      const links: Array<{href: string, download: string}> = await page.evaluate(`
        Array.from(document.querySelectorAll('a[download]')).map(function(a) {
          return { href: a.href, download: a.download };
        })
      `);
      console.log('Download links in DOM:', links);
    }
  });
}

main().catch(console.error);
