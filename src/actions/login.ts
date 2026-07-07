import type { Page } from "playwright-core";
import { generateTOTP } from "../utils/totp";
import dotenv from "dotenv";

dotenv.config();

const username = process.env.QUALIA_USERNAME;
const password = process.env.QUALIA_PASSWORD;
const totpSecret = process.env.QUALIA_TOTP_SECRET;
const baseUrl = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

if (!username) throw new Error("QUALIA_USERNAME is required");
if (!password) throw new Error("QUALIA_PASSWORD is required");

export const SIGNIN_URL = new URL("/signin", baseUrl).href;

/** Fill email + password and click Sign In. Does NOT wait for redirect. */
export async function fillCredentials(page: Page): Promise<void> {
  await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 15_000 });
  await page.locator('input[type="email"]').fill(username!);
  await page.locator('input[type="password"]').fill(password!);
  await page.getByText("Sign In", { exact: true }).click();
}

/** Enter the current TOTP code into Qualia's 6 digit boxes (input.digit). */
export async function fillMfa(page: Page): Promise<void> {
  if (!totpSecret) throw new Error("QUALIA_TOTP_SECRET is required for automated MFA");

  const code = generateTOTP(totpSecret);
  console.log(`  MFA code: ${code}`);

  // 6 inputs: type="tel" class="digit" maxlength=1
  await page.waitForSelector('input.digit', { timeout: 10_000 });
  const boxes = page.locator('input.digit');
  for (let i = 0; i < 6; i++) {
    await boxes.nth(i).fill(code[i]!);
  }
  // Form auto-submits when all 6 digits are entered
}

/**
 * Full login: credentials → MFA if needed (automated via TOTP) → wait for redirect.
 */
export async function login(page: Page): Promise<void> {
  await fillCredentials(page);

  // Wait for post-click navigation: either MFA page or straight to app
  const outcome = await Promise.race([
    page.waitForURL(/signin\/#mfa|signin#mfa/, { timeout: 15_000 }).then(() => "mfa" as const),
    page.waitForURL((url) => !url.href.includes("/signin"), { timeout: 15_000 }).then(() => "home" as const),
  ]).catch(() => "timeout" as const);

  if (outcome === "mfa") {
    await fillMfa(page);
    await page.waitForURL((url) => !url.href.includes("/signin"), { timeout: 30_000 });
  } else if (outcome === "timeout") {
    throw new Error(`Login did not redirect within 15s. Current URL: ${page.url()}`);
  }
  // outcome === "home": already logged in
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  return !page.url().includes("/signin");
}
