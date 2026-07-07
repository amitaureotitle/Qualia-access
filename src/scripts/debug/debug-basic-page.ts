import { withSession } from "../../browserbase";
import { writeFileSync } from "fs";

async function main() {
  await withSession(async (page) => {
    await page.goto("https://aureotitle.qualia.io/orders/TWu7SuTsQcLrg7Q59/basic", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "debug-basic.png", fullPage: false });

    // Find anything that looks like a closing date field
    const html = await page.$$eval("*", (els: any[]) => {
      return els
        .filter(el => {
          const text = (el.innerText ?? el.value ?? el.placeholder ?? el.getAttribute?.("aria-label") ?? "").toLowerCase();
          return text.includes("clos") && el.tagName !== "SCRIPT" && el.children.length < 5;
        })
        .map(el => ({
          tag: el.tagName,
          type: el.type,
          name: el.name,
          id: el.id,
          class: el.className?.slice?.(0, 60),
          placeholder: el.placeholder,
          value: el.value,
          text: (el.innerText ?? "").slice(0, 60),
        }))
        .slice(0, 20);
    });
    writeFileSync("debug-basic.json", JSON.stringify(html, null, 2));
    console.log("Closing-related elements:");
    console.log(JSON.stringify(html, null, 2));
  });
}
main().catch(err => { console.error(err); process.exit(1); });
