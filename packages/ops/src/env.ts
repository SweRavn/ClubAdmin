// SPDX-License-Identifier: AGPL-3.0-only
// Settings for the operator tools: the process environment, falling back to
// .env and .env.local (development and simple self-hosted installations).

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "@clubadmin/devtools/env";

export type OpsEnv = ReadonlyMap<string, string>;

export function loadOpsEnv(): OpsEnv {
  const env = new Map(loadEnv());
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== "") env.set(key, value);
  }
  return env;
}

export function required(env: OpsEnv, key: string): string {
  const value = env.get(key);
  if (!value) throw new Error(`${key} is not set (environment or .env.local)`);
  return value;
}

/** Variables the backup image reads (infra/backup/README.md). */
const BACKUP_VARIABLE = /^(BACKUP_|FILES_)|^POSTGRES_(USER|DB)$/;

/**
 * Writes the backup image's settings to a private temporary env file for
 * `docker run --env-file` (secrets never appear in a process's arguments).
 * Returns the path and a function that removes it.
 */
export function backupEnvFile(
  env: OpsEnv,
  overrides: Record<string, string> = {},
): { path: string; remove: () => void } {
  const lines: string[] = [];
  const values = new Map([...env].filter(([key]) => BACKUP_VARIABLE.test(key)));
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  for (const [key, value] of values) {
    if (value.includes("\n")) throw new Error(`${key} contains a line break`);
    lines.push(`${key}=${value}`);
  }
  const path = join(tmpdir(), `clubadmin-ops-${randomUUID()}.env`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return {
    path,
    remove: () => rmSync(path, { force: true }),
  };
}
