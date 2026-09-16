/**
 * Read-only deeper look at why the Issue All Policies button is disabled.
 * Usage: npx ts-node src/scripts/debug/diagnose-issue-disabled.ts <qualiaId>
 */
import { withSession } from "../../browserbase";
import { navigateToOrder } from "../../utils/navigate";
import { dismissStartupModals } from "../../utils/dismiss-modals";

const qualiaId = process.argv[2];
if (!qualiaId) {
  console.error("Usage: npx ts-node src/scripts/debug/diagnose-issue-disabled.ts <qualiaId>");
  process.exit(1);
}

const SCRIPT = `
(function() {
  var btn = document.querySelector('issueallpolicies');
  var instrumentHeading = Array.from(document.querySelectorAll('*')).find(function(el) {
    return el.children.length === 0 && /Recorded Instruments/i.test(el.textContent || "");
  });
  var instrumentSection = instrumentHeading ? instrumentHeading.closest('section, div, .segment') : null;
  var schemaEls = instrumentSection
    ? Array.from(instrumentSection.querySelectorAll('[data-schema-key]'))
    : [];
  return JSON.stringify({
    buttonPresent: !!btn,
    buttonDisabled: btn ? btn.classList.contains('disabled') : null,
    instrumentSectionOuterHTML: instrumentSection ? instrumentSection.outerHTML.slice(0, 4000) : null,
    schemaKeysInSection: schemaEls.map(function(el) {
      return {
        key: el.getAttribute('data-schema-key'),
        tag: el.tagName,
        value: el.value !== undefined ? el.value : el.textContent.trim().slice(0, 60),
      };
    }),
  }, null, 2);
})()
`;

async function main() {
  await withSession(
    async (page) => {
      await navigateToOrder(page, qualiaId!, "title/final_policy");
      await dismissStartupModals(page);
      await page.waitForTimeout(3000);
      const info = await page.evaluate(SCRIPT);
      console.log(info);
    },
    { timeout: 600, contextId: process.env.QUALIA_CONTEXT_ID }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
