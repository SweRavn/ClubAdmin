// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/ops/backup-status (operators and self-host admins,
// docs/operations/backup-restore.md): the last successful backup of each
// kind, the last restore verification, and warnings when they are too old.
// Warning codes are strings (clients ignore codes they do not know, ADR 0029).

import { z } from "../zod.ts";

export const BACKUP_KINDS = ["database", "monthly", "files", "ledger"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_WARNINGS = [
  /** BACKUP_ENABLED is not true for this installation. */
  "backups_disabled",
  "database_never_backed_up",
  /** No successful database backup within backupHours. */
  "database_backup_stale",
  /** The latest database backup run failed. */
  "database_backup_failed",
  "files_backup_stale",
  "files_backup_failed",
  "restore_never_verified",
  /** No passed restore verification within verificationDays. */
  "restore_verification_stale",
  "restore_verification_failed",
] as const;
export type BackupWarning = (typeof BACKUP_WARNINGS)[number];

const BackupKindStatusSchema = z.object({
  lastSuccessAt: z.iso.datetime().nullable(),
  /** pgBackRest backup label (database backups). */
  lastLabel: z.string().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  lastRunStatus: z.string().nullable().openapi({ example: "succeeded" }),
  sizeBytes: z.number().int().nullable(),
});
export type BackupKindStatus = z.infer<typeof BackupKindStatusSchema>;

export const BackupStatusResponseSchema = z
  .object({
    backupsEnabled: z.boolean(),
    database: BackupKindStatusSchema,
    monthly: BackupKindStatusSchema,
    files: BackupKindStatusSchema,
    ledger: BackupKindStatusSchema,
    verification: z.object({
      lastPassedAt: z.iso.datetime().nullable(),
      lastRunAt: z.iso.datetime().nullable(),
      lastRunStatus: z.string().nullable().openapi({ example: "passed" }),
      label: z.string().nullable(),
      checks: z.array(
        z.object({ name: z.string(), status: z.string(), detail: z.string().optional() }),
      ),
    }),
    warnings: z.array(z.string()).openapi({ example: ["restore_verification_stale"] }),
    thresholds: z.object({
      backupHours: z.number().int(),
      filesHours: z.number().int(),
      verificationDays: z.number().int(),
    }),
  })
  .openapi("BackupStatus");
export type BackupStatusResponse = z.infer<typeof BackupStatusResponseSchema>;

export interface BackupThresholds {
  backupHours: number;
  filesHours: number;
  verificationDays: number;
}

export const DEFAULT_BACKUP_THRESHOLDS: BackupThresholds = {
  backupHours: 24,
  filesHours: 3,
  verificationDays: 8,
};

const olderThan = (iso: string | null, hours: number, now: Date) =>
  iso === null || now.getTime() - new Date(iso).getTime() > hours * 3_600_000;

/** The warnings for a status (backupsEnabled, timestamps) at `now`. */
export function backupWarnings(
  status: Omit<BackupStatusResponse, "warnings" | "thresholds">,
  thresholds: BackupThresholds,
  now: Date,
): BackupWarning[] {
  const warnings: BackupWarning[] = [];
  if (!status.backupsEnabled) warnings.push("backups_disabled");
  const db = status.database;
  if (db.lastSuccessAt === null) warnings.push("database_never_backed_up");
  else if (olderThan(db.lastSuccessAt, thresholds.backupHours, now)) {
    warnings.push("database_backup_stale");
  }
  if (db.lastRunStatus === "failed") warnings.push("database_backup_failed");
  if (status.files.lastRunAt !== null) {
    if (olderThan(status.files.lastSuccessAt, thresholds.filesHours, now)) {
      warnings.push("files_backup_stale");
    }
    if (status.files.lastRunStatus === "failed") warnings.push("files_backup_failed");
  }
  const v = status.verification;
  if (v.lastRunAt === null) warnings.push("restore_never_verified");
  else if (olderThan(v.lastPassedAt, thresholds.verificationDays * 24, now)) {
    warnings.push("restore_verification_stale");
  }
  if (v.lastRunStatus === "failed") warnings.push("restore_verification_failed");
  return warnings;
}
