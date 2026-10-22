// SPDX-License-Identifier: AGPL-3.0-only
// Backup metrics (docs/operations/backup-restore.md, "Monitoring"): the time
// of the last successful backup of each kind and of the last passed restore
// verification, and whether the latest run failed, as OpenTelemetry gauges
// (exported over OTLP; in Prometheus clubadmin_backup_last_success_timestamp_seconds
// and so on, see infra/backup/prometheus-alerts.yml). A job every five
// minutes reads ops.backup_runs and ops.restore_verifications; the gauges
// report the last values read.

import { type Database, sql } from "@clubadmin/db";
import { metrics } from "@opentelemetry/api";
import type { Task } from "graphile-worker";

export interface BackupMetricsSnapshot {
  /** Unix seconds of the last success per kind. */
  lastSuccess: Map<string, number>;
  /** 1 if the latest finished run of the kind failed. */
  lastRunFailed: Map<string, number>;
  verificationLastSuccess: number | null;
  verificationLastRunFailed: number | null;
}

let snapshot: BackupMetricsSnapshot | null = null;
let registered = false;

function registerGauges(): void {
  if (registered) return;
  registered = true;
  const meter = metrics.getMeter("clubadmin-worker");
  const lastSuccess = meter.createObservableGauge("clubadmin.backup.last_success.timestamp", {
    description: "Time of the last successful backup run, by kind",
    unit: "s",
  });
  const lastFailed = meter.createObservableGauge("clubadmin.backup.last_run.failed", {
    description: "1 if the latest backup run of the kind failed",
  });
  const verified = meter.createObservableGauge(
    "clubadmin.restore_verification.last_success.timestamp",
    { description: "Time of the last passed restore verification", unit: "s" },
  );
  const verifyFailed = meter.createObservableGauge(
    "clubadmin.restore_verification.last_run.failed",
    {
      description: "1 if the latest restore verification failed",
    },
  );
  meter.addBatchObservableCallback(
    (result) => {
      if (!snapshot) return;
      for (const [kind, value] of snapshot.lastSuccess)
        result.observe(lastSuccess, value, { kind });
      for (const [kind, value] of snapshot.lastRunFailed)
        result.observe(lastFailed, value, { kind });
      if (snapshot.verificationLastSuccess !== null) {
        result.observe(verified, snapshot.verificationLastSuccess);
      }
      if (snapshot.verificationLastRunFailed !== null) {
        result.observe(verifyFailed, snapshot.verificationLastRunFailed);
      }
    },
    [lastSuccess, lastFailed, verified, verifyFailed],
  );
}

export async function readBackupMetrics(db: Database): Promise<BackupMetricsSnapshot> {
  return db.withSystem("ops:backup_metrics", {}, async (tx) => {
    // Kinds as the API reports them: database = full, differential and incremental backups.
    const runs = await tx.execute<{
      kind: string;
      last_success: number | null;
      last_failed: boolean;
    }>(sql`
      WITH runs AS (
        SELECT CASE WHEN kind IN ('full', 'diff', 'incr') THEN 'database' ELSE kind END AS kind,
               status, started_at, finished_at
        FROM ops.backup_runs WHERE status <> 'running'
      )
      SELECT k.kind,
        (SELECT extract(epoch FROM max(s.finished_at))::float8 FROM runs s
         WHERE s.kind = k.kind AND s.status = 'succeeded') AS last_success,
        (SELECT l.status = 'failed' FROM runs l
         WHERE l.kind = k.kind ORDER BY l.started_at DESC LIMIT 1) AS last_failed
      FROM (SELECT DISTINCT kind FROM runs) k`);
    const verification = await tx.execute<{
      last_success: number | null;
      last_failed: boolean | null;
    }>(sql`
      SELECT
        (SELECT extract(epoch FROM max(finished_at))::float8 FROM ops.restore_verifications
         WHERE status = 'passed') AS last_success,
        (SELECT status = 'failed' FROM ops.restore_verifications
         WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1) AS last_failed`);
    const result: BackupMetricsSnapshot = {
      lastSuccess: new Map(),
      lastRunFailed: new Map(),
      verificationLastSuccess: verification.rows[0]?.last_success ?? null,
      verificationLastRunFailed:
        verification.rows[0]?.last_failed === null || verification.rows[0] === undefined
          ? null
          : Number(verification.rows[0].last_failed),
    };
    for (const row of runs.rows) {
      if (row.last_success !== null) result.lastSuccess.set(row.kind, row.last_success);
      result.lastRunFailed.set(row.kind, Number(row.last_failed));
    }
    return result;
  });
}

export function backupMetricsTask(db: Database): Task {
  registerGauges();
  return async () => {
    snapshot = await readBackupMetrics(db);
  };
}
