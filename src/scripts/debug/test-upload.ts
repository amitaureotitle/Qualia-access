import path from "path";
import { withSession } from "../../browserbase";
import { uploadDocument } from "../../actions/upload-document";
import dotenv from "dotenv";

dotenv.config();

const ORDER_ID = "vAEFGRHqzxxkTzMYe"; // 2026-MO-131
const TEST_FILE = path.resolve(__dirname, "../../../debug-after-signin.png");

async function main() {
  console.log(`Uploading ${path.basename(TEST_FILE)} to order 2026-MO-131...`);

  await withSession(
    async (page) => {
      await uploadDocument(page, ORDER_ID, TEST_FILE, { name: "test-upload" });
      console.log("Upload complete.");
    },
    { contextId: process.env.QUALIA_CONTEXT_ID }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
