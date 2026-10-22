import type { Page } from "playwright-core";
import dotenv from "dotenv";
import type { Driver } from "./driver";

dotenv.config();

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

/** Driver over a Playwright Page -- the robot side (Browserbase sessions). */
export function playwrightDriver(page: Page): Driver {
  return {
    baseUrl: BASE_URL,
    async goto(url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
    evaluate<T>(expression: string) {
      return page.evaluate(expression) as Promise<T>;
    },
    async waitFor(predicate, timeoutMs) {
      return page
        .waitForFunction(predicate, undefined, { timeout: timeoutMs })
        .then(() => true)
        .catch(() => false);
    },
    async click(selector, opts) {
      if (opts?.via === "dom") {
        await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      } else {
        await page.locator(selector).first().click();
      }
    },
    async type(text) {
      await page.keyboard.type(text, { delay: 20 });
    },
    async press(key) {
      await page.keyboard.press(key);
    },
    async show() {
      // Nothing to show on a headless robot.
    },
    sleep(ms) {
      return page.waitForTimeout(ms);
    },
    async screenshot(selector) {
      const buf = await (selector === ":viewport" ? page.screenshot() : page.locator(selector).first().screenshot())
        .catch(() => null);
      return buf ? buf.toString("base64") : undefined;
    },
    note(message) {
      console.log(`  [step] ${message}`);
    },
    async commit() {
      // The robot has no one to ask; the Python side's claim is the gate.
    },
  };
}
