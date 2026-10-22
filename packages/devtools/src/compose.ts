// SPDX-License-Identifier: AGPL-3.0-only
// Thin wrapper around `docker compose` with this project's files and env files.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { backupDir, dockerDir, envFile, envLocalFile } from "./paths.ts";
import { capture, run } from "./process.ts";

export const PROJECT_NAME = "clubadmin";

/** Services started by `pnpm dev`, in the order they are reported. */
export const DEV_SERVICES = [
  "postgres",
  "valkey",
  "zitadel",
  "garage",
  "mailpit",
  "caddy",
] as const;

export interface ComposeOptions {
  /** Profile "full": ClamAV. */
  full?: boolean;
  /** Profile "backup": the backup sidecar (BACKUP_ENABLED=true). */
  backup?: boolean;
}

export function composeBaseArgs(options: ComposeOptions = {}): string[] {
  const args = [
    "compose",
    "--project-name",
    PROJECT_NAME,
    "--file",
    join(dockerDir, "compose.yml"),
    "--file",
    join(dockerDir, "compose.dev.yml"),
  ];
  for (const file of [envFile, envLocalFile]) {
    if (existsSync(file)) args.push("--env-file", file);
  }
  if (options.full) args.push("--profile", "full");
  if (options.backup) args.push("--profile", "backup");
  return args;
}

export function compose(args: readonly string[], options: ComposeOptions = {}) {
  return run("docker", [...composeBaseArgs(options), ...args], {
    ...process.env,
    BACKUP_IMAGE_HASH: backupImageHash(),
  });
}

/** The PostgreSQL image with pgBackRest (infra/backup), shared by postgres and the backup sidecar. */
export const BACKUP_IMAGE = "clubadmin/postgres:18.6-backup";

/** Hash of infra/backup's Dockerfile and scripts: the image is rebuilt when it changes. */
export function backupImageHash(dir = backupDir): string {
  const hash = createHash("sha256");
  const files = ["Dockerfile", ...readdirSync(join(dir, "bin")).map((f) => join("bin", f))].sort();
  for (const file of files) {
    hash.update(`${relative(dir, join(dir, file))}\0`).update(readFileSync(join(dir, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Builds the PostgreSQL image if it is missing or older than infra/backup. */
export async function ensureBackupImage(): Promise<boolean> {
  const label = capture("docker", [
    "image",
    "inspect",
    "--format",
    '{{ index .Config.Labels "org.clubadmin.source-hash" }}',
    BACKUP_IMAGE,
  ]);
  if (label.status === 0 && label.stdout.trim() === backupImageHash()) return true;
  console.log(`Building ${BACKUP_IMAGE} (PostgreSQL with pgBackRest, infra/backup)…`);
  return (await compose(["build", "postgres"])) === 0;
}

export function composeCapture(args: readonly string[], input?: string) {
  return capture("docker", [...composeBaseArgs(), ...args], input);
}

export interface ServiceState {
  service: string;
  state: string;
  health: string;
}

/** Current state of this project's containers (empty if none are running). */
export function serviceStates(): ServiceState[] {
  const result = composeCapture(["ps", "--all", "--format", "json"]);
  if (result.status !== 0) return [];
  return parseComposePs(result.stdout);
}

/** `docker compose ps --format json` prints one JSON object per line (or an array in old versions). */
export function parseComposePs(output: string): ServiceState[] {
  const trimmed = output.trim();
  if (trimmed === "") return [];
  const records: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  return records.map((record) => {
    const r = record as { Service?: unknown; State?: unknown; Health?: unknown };
    return {
      service: typeof r.Service === "string" ? r.Service : "?",
      state: typeof r.State === "string" ? r.State : "unknown",
      health: typeof r.Health === "string" ? r.Health : "",
    };
  });
}

/**
 * Services from `services` that are not running. After a failed `up` these are
 * the ones to recreate: Docker Desktop on WSL loses a container's bind-mount
 * sources when it restarts, and such a container only starts again once it is
 * recreated (data lives in named volumes, so recreating is safe).
 */
export function notRunning(states: readonly ServiceState[], services: readonly string[]): string[] {
  return services.filter(
    (service) => states.find((state) => state.service === service)?.state !== "running",
  );
}
