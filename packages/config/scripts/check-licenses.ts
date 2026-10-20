// SPDX-License-Identifier: AGPL-3.0-only
// Usage: pnpm licenses:check [--mobile]
// Fails if any dependency's licence is not allowed by packages/config/licenses.json.
// --mobile checks only the production dependency tree of apps/mobile, with the
// stricter mobile list (no GPL/LGPL/AGPL, see docs/licensing.md).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findViolations,
  formatViolations,
  type LicensePolicy,
  type Mode,
  parsePnpmLicenses,
} from "./licenses.ts";

const configDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(configDir));
const policy = JSON.parse(readFileSync(join(configDir, "licenses.json"), "utf8")) as LicensePolicy;
const mode: Mode = process.argv.includes("--mobile") ? "mobile" : "default";

const MOBILE_PACKAGE = "@clubadmin/mobile";
const isWorkspacePackage = (name: string) => name === "clubadmin" || name.startsWith("@clubadmin/");

function pnpmLicenses(args: string[]): unknown {
  const output = execFileSync("pnpm", [...args, "licenses", "list", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.trim() === "" ? {} : JSON.parse(output);
}

let packages;
if (mode === "mobile") {
  const mobileManifest = join(repoRoot, "apps", "mobile", "package.json");
  if (!existsSync(mobileManifest)) {
    console.log("licenses:check --mobile: apps/mobile has no package yet, nothing to check.");
    process.exit(0);
  }
  packages = parsePnpmLicenses(pnpmLicenses(["--filter", `${MOBILE_PACKAGE}...`, "--prod"]));
} else {
  packages = parsePnpmLicenses(pnpmLicenses(["--recursive"]));
}

const violations = findViolations(packages, policy, mode, { ignore: isWorkspacePackage });
if (violations.length > 0) {
  console.error(`Licence check failed (${mode} mode): ${violations.length} problem(s)\n`);
  console.error(formatViolations(violations));
  console.error(
    "\nSee docs/licensing.md. Exceptions go in packages/config/licenses.json with an ADR.",
  );
  process.exit(1);
}
console.log(`Licence check passed (${mode} mode): ${packages.length} packages checked.`);
