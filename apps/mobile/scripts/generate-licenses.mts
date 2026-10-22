// SPDX-License-Identifier: AGPL-3.0-only
// Writes src/licenses.json: every third-party package in the app's
// production dependency tree with its licence, for the About screen.
// Generated from the lockfile; CI fails if it is out of date (run
// `pnpm --filter @clubadmin/mobile licenses:generate` after changing
// dependencies).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Entry {
  name?: unknown;
  versions?: unknown;
  version?: unknown;
  license?: unknown;
}

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const output = execFileSync(
  "pnpm",
  ["--filter", "@clubadmin/mobile...", "--prod", "licenses", "list", "--json"],
  { cwd: appDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const groups = JSON.parse(output) as Record<string, Entry[]>;

const packages: { name: string; version: string; license: string }[] = [];
for (const [license, entries] of Object.entries(groups)) {
  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.name.startsWith("@clubadmin/")) continue;
    const versions = Array.isArray(entry.versions)
      ? entry.versions.filter((v): v is string => typeof v === "string")
      : typeof entry.version === "string"
        ? [entry.version]
        : [];
    for (const version of versions) {
      packages.push({
        name: entry.name,
        version,
        license: typeof entry.license === "string" ? entry.license : license,
      });
    }
  }
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// One [name, version, licence] per line: compact in the bundle, readable in diffs.
const file = join(appDir, "src", "licenses.json");
const lines = packages.map((p) => JSON.stringify([p.name, p.version, p.license]));
writeFileSync(file, `{"packages":[\n${lines.join(",\n")}\n]}\n`);
console.log(`${file}: ${packages.length} packages`);
