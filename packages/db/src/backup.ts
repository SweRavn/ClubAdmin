// SPDX-License-Identifier: AGPL-3.0-only
// Database side of `pnpm ops:verify-backup` and the restore runbooks
// (docs/operations/backup-restore.md): checks on a restored database, the
// deletion-ledger replay, and the bookkeeping in ops.restore_verifications.
// Everything here connects as a superuser (the restored cluster's, or
// production's for bookkeeping); never used by the application.

import pg from "pg";

import { findGuardViolations } from "./guards.ts";
import { readMigrationFiles } from "./migrate.ts";

export type CheckStatus = "passed" | "failed" | "warning" | "skipped";

export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  /** Counts, names of tables or migrations; never personal data. */
  detail?: string;
}

/** One entry of the deletion ledger (IDs only). */
export interface LedgerEntry {
  person_id: string;
  erased_at: string;
  reason: string;
}

/**
 * Columns that hold object storage keys (documents, images), checked against
 * the file backup after a restore. Modules that store files add theirs here.
 */
export const OBJECT_KEY_COLUMNS: readonly { table: string; column: string }[] = [];

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "clubadmin-ops" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface BackupSnapshot {
  label: string | null;
  startedAt: Date;
  rowCounts: Record<string, number>;
}

/** The row counts recorded with the latest successful database backup. */
export function latestSnapshot(url: string): Promise<BackupSnapshot | null> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<{
      label: string | null;
      started_at: Date;
      row_counts: Record<string, number>;
    }>(
      `SELECT label, started_at, row_counts FROM ops.backup_runs
       WHERE kind IN ('full', 'diff', 'incr', 'monthly') AND status = 'succeeded' AND row_counts IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0];
    return row ? { label: row.label, startedAt: row.started_at, rowCounts: row.row_counts } : null;
  });
}

export function readLedger(url: string): Promise<LedgerEntry[]> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<LedgerEntry>(
      `SELECT person_id, to_char(erased_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS erased_at, reason
       FROM privacy.deletion_ledger ORDER BY erased_at, person_id`,
    );
    return rows;
  });
}

export interface ReplayResult {
  ledgerEntries: number;
  added: number;
  erased: number;
  unerased: number;
}

/** Merges the external ledger entries and erases every ledgered person again. */
export function replayDeletionLedger(
  url: string,
  external: readonly LedgerEntry[],
): Promise<ReplayResult> {
  return withClient(url, async (client) => {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query<{
        ledger_entries: number;
        added: number;
        erased: number;
      }>("SELECT * FROM privacy.replay_deletion_ledger($1::jsonb)", [JSON.stringify(external)]);
      const { rows: left } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM privacy.unerased_people()",
      );
      await client.query("COMMIT");
      const row = rows[0] ?? { ledger_entries: 0, added: 0, erased: 0 };
      return {
        ledgerEntries: row.ledger_entries,
        added: row.added,
        erased: row.erased,
        unerased: left[0]?.count ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export interface RestoredDatabaseChecks {
  checks: VerificationCheck[];
  /** A sample of object keys referenced by the database, to look up in the file backup. */
  objectKeys: string[];
}

export interface CheckOptions {
  /** Row counts to compare with (latest snapshot); the restored database's own if omitted. */
  snapshot?: BackupSnapshot | null;
  /** Allowed difference per table: max(minDelta, maxDeltaPercent of the snapshot). */
  maxDeltaPercent?: number;
  minDelta?: number;
  /** Deletion-ledger entries kept outside the backup (export, production). */
  externalLedger?: readonly LedgerEntry[];
  objectKeySample?: number;
}

const pass = (name: string, detail?: string): VerificationCheck => ({
  name,
  status: "passed",
  ...(detail ? { detail } : {}),
});
const fail = (name: string, detail: string): VerificationCheck => ({
  name,
  status: "failed",
  detail,
});

/** The checks of `pnpm ops:verify-backup` against a restored (scratch) database. */
export async function checkRestoredDatabase(
  url: string,
  options: CheckOptions = {},
): Promise<RestoredDatabaseChecks> {
  const checks: VerificationCheck[] = [];
  const objectKeys: string[] = [];

  await withClient(url, async (client) => {
    // 1. Migrations: the restored database knows only migrations of this checkout, unchanged.
    const files = readMigrationFiles();
    const known = new Map(files.map((f) => [f.name, f.checksum]));
    const { rows: applied } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM app_meta.schema_migrations ORDER BY name",
    );
    const unknown = applied.filter((m) => known.get(m.name) !== m.checksum).map((m) => m.name);
    const pending = files.filter((f) => !applied.some((m) => m.name === f.name)).map((f) => f.name);
    const latest = applied.at(-1)?.name ?? "none";
    if (unknown.length > 0) {
      checks.push(fail("migrations", `unknown or changed migrations: ${unknown.join(", ")}`));
    } else if (pending.length > 0) {
      checks.push({
        name: "migrations",
        status: "warning",
        detail: `restored at ${latest}; not yet applied: ${pending.join(", ")} (expected for a point before a release)`,
      });
    } else {
      checks.push(pass("migrations", `${applied.length} applied, latest ${latest}`));
    }

    // 2. Row counts against the latest snapshot.
    const { rows: countRows } = await client.query<{ counts: Record<string, number> }>(
      "SELECT ops.key_table_counts() AS counts",
    );
    const counts = countRows[0]?.counts ?? {};
    const snapshot =
      options.snapshot === undefined
        ? await client
            .query<{ label: string | null; started_at: Date; row_counts: Record<string, number> }>(
              `SELECT label, started_at, row_counts FROM ops.backup_runs
               WHERE kind IN ('full', 'diff', 'incr', 'monthly') AND status = 'succeeded' AND row_counts IS NOT NULL
               ORDER BY started_at DESC LIMIT 1`,
            )
            .then((r) =>
              r.rows[0]
                ? {
                    label: r.rows[0].label,
                    startedAt: r.rows[0].started_at,
                    rowCounts: r.rows[0].row_counts,
                  }
                : null,
            )
        : options.snapshot;
    if (!snapshot) {
      checks.push({
        name: "row-counts",
        status: "skipped",
        detail: "no snapshot recorded with a backup",
      });
    } else {
      const maxPercent = options.maxDeltaPercent ?? 5;
      const minDelta = options.minDelta ?? 50;
      const off = Object.entries(snapshot.rowCounts).flatMap(([table, expected]) => {
        const actual = counts[table];
        if (actual === undefined) return [`${table}: missing`];
        const allowed = Math.max(minDelta, Math.ceil((expected * maxPercent) / 100));
        return Math.abs(actual - expected) > allowed ? [`${table}: ${actual} vs ${expected}`] : [];
      });
      const people = counts["public.people"] ?? 0;
      checks.push(
        off.length > 0
          ? fail(
              "row-counts",
              `outside ±max(${minDelta}, ${maxPercent} %) of the snapshot from ${snapshot.startedAt.toISOString()}: ${off.join("; ")}`,
            )
          : pass(
              "row-counts",
              `${Object.keys(snapshot.rowCounts).length} tables within the expected delta (people: ${people})`,
            ),
      );
    }

    // 3 and 4. Row-level security on club tables, history triggers (the same guards as the tests).
    const violations = await findGuardViolations(client);
    const rls = violations.filter((v) => v.rule === "rls").map((v) => v.object);
    checks.push(
      rls.length > 0
        ? fail("row-level-security", `missing on ${rls.join(", ")}`)
        : pass("row-level-security"),
    );
    const history = violations
      .filter((v) => v.rule === "history" || v.rule === "updated_at")
      .map((v) => v.object);
    checks.push(
      history.length > 0
        ? fail("history-triggers", `missing on ${history.join(", ")}`)
        : pass("history-triggers"),
    );

    // Protected identity: flags restored, never an address (constraint present, validated and true).
    const { rows: protectedRows } = await client.query<{
      constraint_ok: boolean;
      violations: number;
      protected: number;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_protected_no_address'
                 AND conrelid = 'public.people'::regclass AND convalidated) AS constraint_ok,
         (SELECT count(*)::int FROM public.people WHERE protected_identity AND address IS NOT NULL) AS violations,
         (SELECT count(*)::int FROM public.people WHERE protected_identity) AS protected`,
    );
    const p = protectedRows[0];
    checks.push(
      p?.constraint_ok && p.violations === 0
        ? pass("protected-identity", `${p.protected} protected people, none with an address`)
        : fail(
            "protected-identity",
            `constraint ${p?.constraint_ok ? "present" : "missing"}, ${p?.violations ?? "?"} protected people with an address`,
          ),
    );

    // Object keys referenced by the database, sampled.
    for (const { table, column } of OBJECT_KEY_COLUMNS) {
      const { rows } = await client.query<{ key: string }>(
        `SELECT ${client.escapeIdentifier(column)} AS key FROM ${table}
         WHERE ${client.escapeIdentifier(column)} IS NOT NULL ORDER BY random() LIMIT $1`,
        [options.objectKeySample ?? 20],
      );
      objectKeys.push(...rows.map((r) => r.key));
    }
  });

  // 5. Deletion ledger: replay, then nobody in it may have personal data.
  const replay = await replayDeletionLedger(url, options.externalLedger ?? []);
  checks.push(
    replay.unerased === 0
      ? pass(
          "deletion-ledger",
          `${replay.ledgerEntries} entries (${replay.added} from outside the backup), ${replay.erased} erased again`,
        )
      : fail("deletion-ledger", `${replay.unerased} erased people still have personal data`),
  );

  return { checks, objectKeys };
}

/** Starts a row in ops.restore_verifications (in production; bookkeeping and audit). */
export function startVerification(
  url: string,
  input: { initiatedBy: string; targetTime?: Date | null },
): Promise<string> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO ops.restore_verifications (initiated_by, target_time) VALUES ($1, $2) RETURNING id",
      [input.initiatedBy, input.targetTime ?? null],
    );
    return rows[0]?.id ?? "";
  });
}

/**
 * Finishes the verification row and writes the audit event for the scratch
 * restore (a copy of all personal data was made and torn down).
 */
export function finishVerification(
  url: string,
  id: string,
  input: { checks: VerificationCheck[]; label: string | null; durationMs: number },
): Promise<void> {
  const failed = input.checks.some((c) => c.status === "failed");
  return withClient(url, async (client) => {
    await client.query("BEGIN");
    await client.query(
      `UPDATE ops.restore_verifications
       SET status = $2, finished_at = now(), checks = $3, label = $4, duration_ms = $5 WHERE id = $1`,
      [
        id,
        failed ? "failed" : "passed",
        JSON.stringify(input.checks),
        input.label,
        input.durationMs,
      ],
    );
    await client.query(
      `INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
       VALUES ('system_job', 'backup.restore.verified', 'restore_verification', $1, '{}', $2)`,
      [id, `ops:verify-backup:${id}`],
    );
    await client.query("COMMIT");
  });
}
