// SPDX-License-Identifier: AGPL-3.0-only
// Bundles the app as a production build (APP_VARIANT=production) and checks
// it (ADR 0028):
// - development-only code (the DEV_AUTH persona picker, development tokens)
//   is not in the bundle;
// - the Hermes bytecode bundle stays within its budget.
// Usage: pnpm --filter @clubadmin/mobile bundle:check [--platform android|ios]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Budget for the Hermes bytecode bundle, set from the first measurement at
 * P0.10 (4.16 MiB on Android) plus about 10 % (docs/performance.md). Raise
 * it deliberately, with the reason, when a feature needs it.
 */
const BUDGET_BYTES = 4.6 * 1024 * 1024;
/** Strings that only development-only modules contain. */
const FORBIDDEN = ["/api/v1/dev/tokens", "/api/v1/dev/personas", "persona-picker"];

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const platformIndex = process.argv.indexOf("--platform");
const platform = platformIndex > 0 ? (process.argv[platformIndex + 1] ?? "android") : "android";
const outDir = mkdtempSync(join(tmpdir(), "clubadmin-bundle-"));

execFileSync(
  "pnpm",
  ["exec", "expo", "export", "--platform", platform, "--clear", "--output-dir", outDir],
  {
    cwd: appDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, APP_VARIANT: "production", EXPO_PUBLIC_APP_VARIANT: "production" },
  },
);

const jsDir = join(outDir, "_expo", "static", "js", platform);
const bundles = readdirSync(jsDir).filter((f) => f.endsWith(".hbc") || f.endsWith(".js"));
let failed = false;
for (const name of bundles) {
  const file = join(jsDir, name);
  const size = statSync(file).size;
  const content = readFileSync(file);
  const found = FORBIDDEN.filter((marker) => content.includes(marker));
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  console.log(`${platform} ${name}: ${mb(size)} (budget ${mb(BUDGET_BYTES)})`);
  if (size > BUDGET_BYTES) {
    console.error(`Bundle over budget by ${mb(size - BUDGET_BYTES)}.`);
    failed = true;
  }
  if (found.length > 0) {
    console.error(`Development-only code in the production bundle: ${found.join(", ")}`);
    failed = true;
  }
}
if (bundles.length === 0) {
  console.error(`No bundle found in ${jsDir}.`);
  failed = true;
}
process.exit(failed ? 1 : 0);
