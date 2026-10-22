// Bundles the Workflow Runner extension (panel + background) into
// extension/dist/. The extension holds no workflow code -- workflows run
// locally and drive it over the bridge (src/steps/bridge-driver.ts) -- so
// it only needs rebuilding when the extension itself changes.
// Usage: npm run build:extension   (add --watch to rebuild on change)
import { build, context } from "esbuild";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const options = {
  entryPoints: { panel: join(here, "src/panel.ts"), background: join(here, "src/background.ts") },
  outdir: join(here, "dist"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
