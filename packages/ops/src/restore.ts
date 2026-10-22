// SPDX-License-Identifier: AGPL-3.0-only
// In-place restore of the installation's database (runbooks 2 and 3 in
// infra/backup/runbooks/): stop PostgreSQL and the backup sidecar, restore
// with pgBackRest (latest or a point in time), start PostgreSQL, wait for
// recovery, replay the deletion ledger, restart the sidecar and take a new
// full backup.

import { readLedger, replayDeletionLedger, type ReplayResult } from "@clubadmin/db/admin";

import { compose, composeCapture } from "./docker.ts";
import { type OpsEnv, required } from "./env.ts";
import { exportedLedger, mergeLedgers } from "./verify.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RestoreOptions {
  time?: Date;
  /** Database whose ledger is merged too (for example the damaged production copy). */
  ledgerFrom?: string;
  /** Take a full backup afterwards (default true). */
  backupAfter?: boolean;
  log: (message: string) => void;
}

async function waitForPrimary(env: OpsEnv, timeoutS: number): Promise<void> {
  const user = env.get("POSTGRES_USER") ?? "postgres";
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const state = composeCapture(env, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      user,
      "-d",
      "postgres",
      "-Atc",
      "SELECT pg_is_in_recovery()",
    ]);
    if (state.status === 0 && state.stdout.trim() === "f") return;
    if (Date.now() > deadline)
      throw new Error("recovery did not finish in time (pnpm dev:logs postgres)");
    await sleep(2000);
  }
}

/** Replays the deletion ledger on `databaseUrl` with the entries kept outside the backups. */
export async function replayLedger(
  env: OpsEnv,
  databaseUrl: string,
  ledgerFrom?: string,
): Promise<ReplayResult> {
  const exported = exportedLedger(env);
  if (exported.error)
    throw new Error(`could not read the exported deletion ledger: ${exported.error}`);
  const other = ledgerFrom ? await readLedger(ledgerFrom) : [];
  return replayDeletionLedger(databaseUrl, mergeLedgers(exported.entries, other));
}

export async function restoreInPlace(env: OpsEnv, options: RestoreOptions): Promise<ReplayResult> {
  const { log } = options;
  const adminUrl = required(env, "DATABASE_ADMIN_URL");
  const step = async (what: string, args: string[]) => {
    log(what);
    if ((await compose(env, args)) !== 0) throw new Error(`${what} failed`);
  };

  await step("Stopping the backup sidecar and PostgreSQL…", ["stop", "backup", "postgres"]);
  await step(
    `Restoring ${options.time ? `to ${options.time.toISOString()}` : "the latest backup and WAL"}…`,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "backup",
      "clubadmin-backup",
      "restore",
      "--delta",
      ...(options.time ? ["--time", options.time.toISOString()] : []),
    ],
  );
  await step("Starting PostgreSQL (replays WAL, then promotes)…", ["up", "--detach", "postgres"]);
  await waitForPrimary(env, Number(env.get("OPS_RECOVERY_TIMEOUT_S") ?? 1800));
  log("Recovery finished. Replaying the deletion ledger…");
  const replay = await replayLedger(env, adminUrl, options.ledgerFrom);
  log(
    `Deletion ledger: ${replay.ledgerEntries} entries (${replay.added} from outside the backup), ${replay.erased} people erased again, ${replay.unerased} left with personal data.`,
  );
  if (replay.unerased > 0)
    throw new Error("erased people still have personal data after the replay");
  await step("Starting the backup sidecar…", ["up", "--detach", "backup"]);
  if (options.backupAfter !== false) {
    // A new timeline starts here: a full backup makes the next restore independent of the old one.
    await step("Taking a full backup of the restored database…", [
      "exec",
      "-T",
      "backup",
      "clubadmin-backup",
      "backup",
      "full",
    ]);
  }
  return replay;
}
