import { withSession } from "../../browserbase";
import { searchOrders } from "../../utils/navigate";

async function main() {
  await withSession(async (page) => {
    const results = await searchOrders(page, "607 Jasmin Drive");
    console.log(`Found ${results.length} orders:`);
    for (const r of results) {
      console.log(`  ${r.orderNumber}  |  ${r.label}`);
    }
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
