import { withSession } from "../../browserbase";
import { writeFileSync } from "fs";

async function main() {
  await withSession(async (page) => {
    const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";
    await page.goto(new URL("/home/orders", BASE_URL).href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "debug-modal.png" });

    // Dump the engagement modal HTML
    const html = await page.$$eval(".amplitude-engagement-modal-container", (els: any[]) =>
      els[0]?.outerHTML?.slice(0, 3000) ?? "not found"
    );
    writeFileSync("debug-modal.html", html);
    console.log("Modal HTML saved. Found:", html !== "not found");
    console.log(html.slice(0, 500));
  });
}
main().catch(err => { console.error(err); process.exit(1); });
