// Shield Test ONLY.
import { withSession } from "../../browserbase";
import { fillBorrower } from "../../actions/fill-borrower";
async function main() {
  const value = process.argv[2] || "Single";
  const r = await withSession((page) => fillBorrower(page, "QCiFdiPLQCHMR3itJ", 0, {
    marital_status: value, current_address: { street: "1 Brookings Dr", state: "MO" } }),
    { timeout: 300, contextId: process.env.QUALIA_CONTEXT_ID });
  console.log(JSON.stringify(r));
}
main().catch(err => { console.error(err); process.exit(1); });
