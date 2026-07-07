import { withSession } from "../../browserbase";
import { writeFileSync } from "fs";

async function main() {
  await withSession(async (page) => {
    const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";
    await page.goto(new URL("/home/orders", BASE_URL).href, { waitUntil: "domcontentloaded" });

    const searchBox = page.getByPlaceholder("Find order...");
    await searchBox.click();
    await searchBox.fill("607 Jasmin Drive");

    // Wait a moment for results
    await page.waitForTimeout(3000);

    // Screenshot
    await page.screenshot({ path: "debug-search.png", fullPage: false });
    console.log("Screenshot saved to debug-search.png");

    // Dump the relevant HTML around the search input
    const html = await page.$$eval(".search, [class*='search']", (els: any[]) =>
      els[0] ? els[0].outerHTML.slice(0, 3000) : "No .search element found"
    );
    writeFileSync("debug-search.html", html);
    console.log("HTML saved to debug-search.html");

    // Also try to find anything that appeared after typing
    const allResults = await page.$$eval(".result, .results, [class*='result']", (els: any[]) =>
      els.map((el: any) => ({
        tag: el.tagName,
        classes: el.className,
        text: (el.innerText ?? "").slice(0, 100),
      }))
    );
    console.log("Result candidates:", JSON.stringify(allResults, null, 2));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
