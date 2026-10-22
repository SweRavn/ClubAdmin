// SPDX-License-Identifier: AGPL-3.0-only
// Thin wrapper around `docker compose` with this project's files and env files.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { dockerDir, envFile, envLocalFile } from "./paths.ts";
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

export function composeBaseArgs(options: { full?: boolean } = {}): string[] {
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
  return args;
}

export function compose(args: readonly string[], options: { full?: boolean } = {}) {
  return run("docker", [...composeBaseArgs(options), ...args]);
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
