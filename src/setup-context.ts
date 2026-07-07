/**
 * One-time setup: creates a persistent Browserbase context.
 * Login (including MFA) is now fully automated via TOTP.
 *
 * Usage: npx ts-node src/setup-context.ts
 */
import { createContext, createSession, connectToBrowser } from "./browserbase";
import { login } from "./actions/login";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const existingContextId = process.env.QUALIA_CONTEXT_ID;
  let contextId: string;

  if (existingContextId) {
    contextId = existingContextId;
    console.log(`Reusing existing context: ${contextId}`);
  } else {
    console.log("Creating persistent context...");
    contextId = await createContext();
    console.log(`Context created: ${contextId}`);
  }

  console.log("Starting session...");
  const session = await createSession({ contextId, persistContext: true });
  const { browser, page } = await connectToBrowser(session.connectUrl);

  try {
    console.log("Logging into Qualia...");
    await login(page);
    console.log(`Logged in — landed on: ${page.url()}`);
  } finally {
    await browser.close();
  }

  await new Promise((r) => setTimeout(r, 3000));
  console.log("\n✓ Done. QUALIA_CONTEXT_ID =", contextId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
