// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm ops:verify-backup` (docs/operations/backup-restore.md, "Verification"):
// restores the latest backup (or a point in time) into a temporary
// PostgreSQL container, checks it, replays the deletion ledger, records the
// result in ops.restore_verifications and always tears the copy down.

import { hostname } from "node:os";

import {
  checkRestoredDatabase,
  finishVerification,
  latestSnapshot,
  type LedgerEntry,
  readLedger,
  startVerification,
  type VerificationCheck,
} from "@clubadmin/db/admin";

import { backupFor, parseBackupInfo } from "./backup-info.ts";
import { backupImage, capture, dockerNetwork } from "./docker.ts";
import { backupEnvFile, type OpsEnv, required } from "./env.ts";
import { checkObjectLock } from "./object-lock.ts";

export interface VerifyOptions {
  /** Point in time to restore to; latest when omitted. */
  time?: Date;
  /** Record the result in production's ops.restore_verifications (default true). */
  record?: boolean;
  /** Keep the container and volume for inspection. */
  keep?: boolean;
  log?: (message: string) => void;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerificationCheck[];
  label: string | null;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Merges ledger entries from several sources (IDs only), oldest first. */
export function mergeLedgers(...sources: readonly (readonly LedgerEntry[])[]): LedgerEntry[] {
  const byPerson = new Map<string, LedgerEntry>();
  for (const entry of sources.flat()) {
    if (!byPerson.has(entry.person_id)) byPerson.set(entry.person_id, entry);
  }
  return [...byPerson.values()].sort((a, b) => a.erased_at.localeCompare(b.erased_at));
}

/** Runs a command of the backup image in a one-off container with the backup settings. */
function backupTool(
  env: OpsEnv,
  args: readonly string[],
  options: { volume?: string; input?: string; overrides?: Record<string, string> } = {},
) {
  const file = backupEnvFile(env, options.overrides);
  try {
    const network = dockerNetwork(env);
    return capture(
      "docker",
      [
        "run",
        "--rm",
        ...(options.input === undefined ? [] : ["-i"]),
        "--env-file",
        file.path,
        ...(network ? ["--network", network] : []),
        ...(options.volume ? ["--volume", `${options.volume}:/var/lib/postgresql`] : []),
        backupImage(env),
        "clubadmin-backup",
        ...args,
      ],
      options.input,
    );
  } finally {
    file.remove();
  }
}

/** The deletion ledger exported next to the backups ([] when there is none yet). */
export function exportedLedger(env: OpsEnv): { entries: LedgerEntry[]; error?: string } {
  const result = backupTool(env, ["ledger-cat"]);
  if (result.status !== 0) {
    return /not found|doesn't exist|directory not found/i.test(result.stderr)
      ? { entries: [] }
      : { entries: [], error: result.stderr.trim().split("\n").at(-1) ?? "ledger-cat failed" };
  }
  return { entries: JSON.parse(result.stdout || "[]") as LedgerEntry[] };
}

async function reachable<T>(what: () => Promise<T>): Promise<T | undefined> {
  try {
    return await what();
  } catch {
    return undefined;
  }
}

export async function verifyBackup(
  env: OpsEnv,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const productionUrl = required(env, "DATABASE_ADMIN_URL");
  const id = `clubadmin-verify-${started.toString(36)}`;
  const checks: VerificationCheck[] = [];
  let label: string | null = null;

  const verificationId =
    options.record === false
      ? undefined
      : await reachable(() =>
          startVerification(productionUrl, {
            initiatedBy:
              env.get("OPS_INITIATED_BY") ??
              (env.get("GITHUB_RUN_ID") ? `ci:${env.get("GITHUB_RUN_ID")}` : hostname()),
            targetTime: options.time ?? null,
          }),
        );
  if (options.record !== false && !verificationId) {
    log("Production database not reachable: the result is printed but not recorded.");
  }

  const fileEnv = backupEnvFile(env, { BACKUP_ENABLED: "false" });
  try {
    // Which backup the restore starts from.
    const info = backupTool(env, ["info", "--output=json", "--repo=1"]);
    if (info.status !== 0) throw new Error(`pgBackRest info failed: ${info.stderr.trim()}`);
    label = backupFor(parseBackupInfo(info.stdout), options.time)?.label ?? null;
    if (!label)
      throw new Error(options.time ? "no backup finished before that time" : "no backup yet");
    log(
      `Restoring ${options.time ? `to ${options.time.toISOString()} from` : "the latest WAL on"} backup ${label}…`,
    );

    // 1–2. Temporary volume and restore (never archives: --scratch).
    if (capture("docker", ["volume", "create", id]).status !== 0)
      throw new Error("docker volume create failed");
    const restore = backupTool(
      env,
      ["restore", "--scratch", ...(options.time ? ["--time", options.time.toISOString()] : [])],
      { volume: id },
    );
    if (restore.status !== 0) {
      throw new Error(`restore failed: ${restore.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    checks.push({ name: "restore", status: "passed", detail: `from ${label}` });

    // Start PostgreSQL on the restored data: replays WAL, then promotes.
    const network = dockerNetwork(env);
    const startResult = capture("docker", [
      "run",
      "--detach",
      "--name",
      id,
      "--env-file",
      fileEnv.path,
      ...(network ? ["--network", network] : []),
      "--volume",
      `${id}:/var/lib/postgresql`,
      "--publish",
      "127.0.0.1::5432",
      backupImage(env),
      "postgres",
      "-c",
      "archive_mode=off",
    ]);
    if (startResult.status !== 0)
      throw new Error(`could not start PostgreSQL: ${startResult.stderr.trim()}`);

    const user = decodeURIComponent(new URL(productionUrl).username);
    const deadline = Date.now() + Number(env.get("OPS_RECOVERY_TIMEOUT_S") ?? 1800) * 1000;
    for (;;) {
      const state = capture("docker", [
        "exec",
        id,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-Atc",
        "SELECT pg_is_in_recovery()",
      ]);
      if (state.status === 0 && state.stdout.trim() === "f") break;
      if (
        capture("docker", ["inspect", "--format", "{{.State.Running}}", id]).stdout.trim() !==
        "true"
      ) {
        const logs = capture("docker", ["logs", "--tail", "20", id]);
        throw new Error(`PostgreSQL stopped during recovery:\n${logs.stdout}${logs.stderr}`);
      }
      if (Date.now() > deadline) throw new Error("recovery did not finish in time");
      await sleep(1000);
    }
    const recoveredMs = Date.now() - started;
    checks.push({
      name: "recovery",
      status: "passed",
      detail: `promoted after ${Math.round(recoveredMs / 1000)} s`,
    });

    const port = capture("docker", ["port", id, "5432/tcp"])
      .stdout.trim()
      .split("\n")[0]
      ?.split(":")
      .at(-1);
    const restoredUrl = new URL(productionUrl);
    restoredUrl.hostname = "127.0.0.1";
    restoredUrl.port = port ?? "";

    // 3–4. Checks on the restored database, including the ledger replay.
    const production = await reachable(async () => ({
      snapshot: await latestSnapshot(productionUrl),
      ledger: await readLedger(productionUrl),
    }));
    const exported = exportedLedger(env);
    if (exported.error) {
      checks.push({ name: "ledger-export", status: "failed", detail: exported.error });
    } else {
      checks.push({
        name: "ledger-export",
        status: "passed",
        detail: `${exported.entries.length} entries outside the backup`,
      });
    }
    const restored = await checkRestoredDatabase(restoredUrl.toString(), {
      ...(production ? { snapshot: production.snapshot } : {}),
      externalLedger: mergeLedgers(exported.entries, production?.ledger ?? []),
    });
    checks.push(...restored.checks);

    // Index and heap consistency.
    const amcheck = capture("docker", [
      "exec",
      id,
      "pg_amcheck",
      "-U",
      user,
      "--all",
      "--install-missing",
      "--no-strict-names",
    ]);
    checks.push(
      amcheck.status === 0
        ? { name: "pg_amcheck", status: "passed", detail: "all databases, all indexes" }
        : {
            name: "pg_amcheck",
            status: "failed",
            detail: `${amcheck.stdout}${amcheck.stderr}`.trim().split("\n").slice(-5).join(" | "),
          },
    );

    // Object keys referenced by the database exist in the file replica.
    if (restored.objectKeys.length === 0) {
      checks.push({
        name: "file-objects",
        status: "skipped",
        detail: "no tables reference stored files yet",
      });
    } else {
      const missing = backupTool(env, ["files-check"], {
        input: `${restored.objectKeys.join("\n")}\n`,
      });
      const lost = missing.stdout.split("\n").filter(Boolean);
      checks.push(
        missing.status !== 0
          ? { name: "file-objects", status: "failed", detail: missing.stderr.trim() }
          : lost.length > 0
            ? {
                name: "file-objects",
                status: "failed",
                detail: `${lost.length} of ${restored.objectKeys.length} sampled files missing in the replica`,
              }
            : {
                name: "file-objects",
                status: "passed",
                detail: `${restored.objectKeys.length} sampled files present`,
              },
      );
    }
  } catch (error) {
    checks.push({ name: "restore", status: "failed", detail: (error as Error).message });
  } finally {
    fileEnv.remove();
    if (options.keep) {
      log(
        `Kept container and volume ${id} (remove with: docker rm -f ${id} && docker volume rm ${id}).`,
      );
    } else {
      capture("docker", ["rm", "--force", "--volumes", id]);
      capture("docker", ["volume", "rm", "--force", id]);
    }
  }

  // Immutability of the backup bucket (warning only: Garage has no object lock).
  const lock = await checkObjectLock(env);
  checks.push({
    name: "object-lock",
    status: lock.status === "active" ? "passed" : lock.status === "error" ? "failed" : "warning",
    detail: lock.detail,
  });

  const durationMs = Date.now() - started;
  if (verificationId) {
    await finishVerification(productionUrl, verificationId, { checks, label, durationMs }).catch(
      (error: unknown) => log(`Could not record the result: ${(error as Error).message}`),
    );
  }
  return { ok: !checks.some((c) => c.status === "failed"), checks, label, durationMs };
}

/** For logs and the job summary: one line per check. */
export function formatChecks(checks: readonly VerificationCheck[]): string {
  const icon = { passed: "✔", failed: "✘", warning: "!", skipped: "–" } as const;
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map(
      (c) =>
        `${icon[c.status]} ${c.name.padEnd(width)}  ${c.status}${c.detail ? `: ${c.detail}` : ""}`,
    )
    .join("\n");
}
