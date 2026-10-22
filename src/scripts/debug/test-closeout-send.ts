/**
 * Compose-only dry run of sendMessage (the closeout workflow's Send Message
 * step) -- fills subject, body, recipients, "via", and attachments, saves a
 * screenshot of the compose popup, and never clicks Send.
 *
 * Usage: npx ts-node src/scripts/debug/test-closeout-send.ts <qualiaId> <input.json> [screenshot.png]
 * input.json: { subject, body, recipients: string[], attachments: [{ name, folderPath }] }
 */
import { readFileSync, writeFileSync } from "fs";
import { withSession } from "../../browserbase";
import { sendMessage, SendMessageInput } from "../../actions/send-message";

const qualiaId = process.argv[2];
const inputPath = process.argv[3];
const shotPath = process.argv[4] ?? "closeout-compose.png";

if (!qualiaId || !inputPath) {
  console.error("Usage: npx ts-node src/scripts/debug/test-closeout-send.ts <qualiaId> <input.json> [screenshot.png]");
  process.exit(1);
}

async function main() {
  const input = JSON.parse(readFileSync(inputPath!, "utf-8")) as SendMessageInput;
  await withSession(async (page) => {
    const result = await sendMessage(page, qualiaId!, { ...input, composeOnly: true });
    if (result.screenshot) {
      writeFileSync(shotPath, Buffer.from(result.screenshot, "base64"));
      result.screenshot = `[saved to ${shotPath}]`;
    }
    console.log(JSON.stringify(result, null, 2));
  }, { timeout: 600, contextId: process.env.QUALIA_CONTEXT_ID });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
