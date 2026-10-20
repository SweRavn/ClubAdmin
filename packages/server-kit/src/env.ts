// SPDX-License-Identifier: AGPL-3.0-only
// Loads .env and .env.local from the repository root (development). Real
// environment variables always win; .env.local wins over .env.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findRepoRoot(start = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Returns the files that were loaded. */
export function loadEnvFiles(root = findRepoRoot()): string[] {
  if (root === undefined) return [];
  const loaded: string[] = [];
  // process.loadEnvFile never overrides variables that are already set, so
  // load the file with the highest priority first.
  for (const name of [".env.local", ".env"]) {
    const file = join(root, name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(file);
    }
  }
  return loaded;
}
