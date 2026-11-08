// SPDX-License-Identifier: AGPL-3.0-only
// The README matches the repository (P1.14 finding 2): every relative link
// points at a file or folder that exists, and every `pnpm <script>` it names
// is a script of the root package.json (or a pnpm command).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const scripts = Object.keys(
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: object }).scripts,
);
/** pnpm's own commands, and words after "pnpm" in prose. */
const PNPM_COMMANDS = new Set(["install", "exec", "version"]);

describe("README.md", () => {
  it("links only to files that exist", () => {
    const links = [...readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
    const missing = links
      .filter((l) => !/^[a-z]+:/i.test(l))
      .filter((l) => !existsSync(join(root, l)));
    expect(missing).toEqual([]);
  });

  it("names only pnpm scripts that exist", () => {
    const named = [...readme.matchAll(/pnpm ([a-z][a-z:-]*)/g)].map((m) => m[1]!);
    const unknown = named.filter((s) => !PNPM_COMMANDS.has(s) && !scripts.includes(s));
    expect(unknown).toEqual([]);
  });
});
