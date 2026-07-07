/**
 * Fetch CDF charge rows for a given order + section.
 *
 * Import:
 *   import { getCharges, CdfSection } from "./scripts/read/get-charges";
 *   const rows = await getCharges("2026-MO-212", "services_not_shopped_for");
 *
 * Run standalone:
 *   npx ts-node src/scripts/read/get-charges.ts [orderNumber] [section]
 *   npx ts-node src/scripts/read/get-charges.ts 2026-MO-212 services_not_shopped_for
 */
import { withSession } from "../../browserbase";
import { resolveOrderId } from "../../utils/navigate";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.QUALIA_BASE_URL ?? "https://aureotitle.qualia.io/";

export type CdfSection =
  | "origination_charges"
  | "services_not_shopped_for"
  | "services_shopped_for"
  | "taxes_and_fees"
  | "prepaids"
  | "escrows"
  | "other_charges"
  | "lender_credits";

export interface ChargeRow {
  line: string;
  description: string;
  payee: string;
  borrowerAtClosing: string;
  borrowerBeforeClosing: string;
  sellerAtClosing: string;
  sellerBeforeClosing: string;
  byOthers: string;
}

/**
 * Returns the charge rows for the given order number and CDF section.
 * Empty lines (no description, no amounts) are excluded.
 */
export async function getCharges(
  orderNumber: string,
  section: CdfSection = "services_not_shopped_for"
): Promise<ChargeRow[]> {
  return withSession(async (page) => {
    const orderId = await resolveOrderId(page, orderNumber);
    const url = new URL(`/orders/${orderId}/cdf/${section}`, BASE_URL).href;

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("table", { timeout: 15_000 });
    await page.waitForTimeout(2000);

    const rawRows = await page.evaluate(/* js */ `(function() {
      var results = [];
      var tableRows = Array.from(document.querySelectorAll("tr"));

      tableRows.forEach(function(row) {
        var cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) return;

        var cellValues = cells.map(function(td) {
          var input = td.querySelector("input[type='text'], input:not([type='checkbox']):not([type='radio']):not([type='hidden']), textarea");
          if (input && input.value) return input.value.trim();
          var ddText = td.querySelector(".dropdown .text");
          if (ddText) {
            var t = ddText.textContent.trim();
            if (t && t !== "Payee") return t;
          }
          return td.innerText.replace(/\\s+/g, " ").trim();
        });

        results.push(cellValues);
      });

      return results;
    })()`);

    const rows = rawRows as string[][];

    return rows
      .filter((r) => {
        // Keep rows where description or at least one amount is non-empty
        const desc = r[1] ?? "";
        const amounts = r.slice(2);
        return desc.trim().length > 0 || amounts.some((v) => /\$[\d,]+/.test(v));
      })
      .map((r) => ({
        line: r[0] ?? "",
        description: r[1] ?? "",
        payee: r[2] ?? "",
        borrowerAtClosing: r[3] ?? "",
        borrowerBeforeClosing: r[4] ?? "",
        sellerAtClosing: r[5] ?? "",
        sellerBeforeClosing: r[6] ?? "",
        byOthers: r[7] ?? "",
      }));
  });
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (require.main === module) {
  const orderNumber = process.argv[2] ?? "2026-MO-212";
  const section = (process.argv[3] ?? "services_not_shopped_for") as CdfSection;

  console.log(`\nFetching "${section}" charges for ${orderNumber}...\n`);

  getCharges(orderNumber, section)
    .then((rows) => {
      if (rows.length === 0) {
        console.log("(no charges found)");
        return;
      }
      const col = (s: string) => s.padEnd(24).slice(0, 24);
      console.log(
        [col("Line"), col("Description"), col("Payee"), col("Borrower @Close"), col("Borrower Before"), col("Seller @Close"), col("Seller Before"), col("By Others")].join(" | ")
      );
      console.log("─".repeat(27 * 8));
      for (const r of rows) {
        console.log(
          [col(r.line), col(r.description), col(r.payee), col(r.borrowerAtClosing), col(r.borrowerBeforeClosing), col(r.sellerAtClosing), col(r.sellerBeforeClosing), col(r.byOthers)].join(" | ")
        );
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
