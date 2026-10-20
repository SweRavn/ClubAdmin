// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from "node:child_process";

import { repoRoot } from "./paths.ts";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and captures its output. Never throws for a non-zero exit. */
export function capture(command: string, args: readonly string[], input?: string): RunResult {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

/** Runs a command with inherited stdio; resolves with its exit code. */
export function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}
