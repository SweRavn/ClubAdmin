// SPDX-License-Identifier: AGPL-3.0-only
// Backup status for operators (docs/operations/backup-restore.md, "Admin
// visibility"): the last successful backup of each kind, the last restore
// verification, and warnings when they are older than the thresholds.

import type { ActorContext, Database } from "@clubadmin/db";
import {
  type BackupKindStatus,
  type BackupStatusResponse,
  type BackupThresholds,
  backupWarnings,
} from "@clubadmin/shared";

import * as repo from "./backups.repository.ts";

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

function kindStatus(rows: repo.BackupKindRows): BackupKindStatus {
  return {
    lastSuccessAt: iso(rows.lastSuccess?.finishedAt),
    lastLabel: rows.lastSuccess?.label ?? null,
    lastRunAt: iso(rows.lastRun?.finishedAt),
    lastRunStatus: rows.lastRun?.status ?? null,
    sizeBytes: rows.lastSuccess?.sizeBytes ?? null,
  };
}

export class BackupsService {
  private readonly db: Database;
  private readonly settings: { enabled: boolean; thresholds: BackupThresholds };

  constructor(db: Database, settings: { enabled: boolean; thresholds: BackupThresholds }) {
    this.db = db;
    this.settings = settings;
  }

  async status(context: ActorContext, now = new Date()): Promise<BackupStatusResponse> {
    const status = await this.db.withActor(context, async (tx) => {
      const [database, monthly, files, ledger, verifications] = await Promise.all([
        repo.latestRuns(tx, ["full", "diff", "incr"]),
        repo.latestRuns(tx, ["monthly"]),
        repo.latestRuns(tx, ["files"]),
        repo.latestRuns(tx, ["ledger"]),
        repo.latestVerifications(tx),
      ]);
      return {
        backupsEnabled: this.settings.enabled,
        database: kindStatus(database),
        monthly: kindStatus(monthly),
        files: kindStatus(files),
        ledger: kindStatus(ledger),
        verification: {
          lastPassedAt: iso(verifications.lastPassed?.finishedAt),
          lastRunAt: iso(verifications.lastRun?.finishedAt),
          lastRunStatus: verifications.lastRun?.status ?? null,
          label: verifications.lastRun?.label ?? null,
          checks: verifications.lastRun?.checks ?? [],
        },
      };
    });
    return {
      ...status,
      warnings: backupWarnings(status, this.settings.thresholds, now),
      thresholds: this.settings.thresholds,
    };
  }
}
