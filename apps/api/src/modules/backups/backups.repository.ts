// SPDX-License-Identifier: AGPL-3.0-only
// The latest backup runs and restore verifications (ops schema, written by
// the backup tooling; migrations/0005_backup_ops.sql).

import { and, desc, eq, inArray, ne, tables, type Tx } from "@clubadmin/db";

const { backupRuns, restoreVerifications } = tables;

export type BackupRunRow = typeof backupRuns.$inferSelect;
export type VerificationRow = typeof restoreVerifications.$inferSelect;

export interface BackupKindRows {
  lastSuccess: BackupRunRow | null;
  lastRun: BackupRunRow | null;
}

/** Latest finished run and latest successful run of the given kinds (one index scan each). */
export async function latestRuns(
  tx: Tx,
  kinds: readonly BackupRunRow["kind"][],
): Promise<BackupKindRows> {
  const [lastRun] = await tx
    .select()
    .from(backupRuns)
    .where(and(inArray(backupRuns.kind, [...kinds]), ne(backupRuns.status, "running")))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1);
  const [lastSuccess] = await tx
    .select()
    .from(backupRuns)
    .where(and(inArray(backupRuns.kind, [...kinds]), eq(backupRuns.status, "succeeded")))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1);
  return { lastRun: lastRun ?? null, lastSuccess: lastSuccess ?? null };
}

export async function latestVerifications(
  tx: Tx,
): Promise<{ lastRun: VerificationRow | null; lastPassed: VerificationRow | null }> {
  const [lastRun] = await tx
    .select()
    .from(restoreVerifications)
    .where(ne(restoreVerifications.status, "running"))
    .orderBy(desc(restoreVerifications.startedAt))
    .limit(1);
  const [lastPassed] = await tx
    .select()
    .from(restoreVerifications)
    .where(eq(restoreVerifications.status, "passed"))
    .orderBy(desc(restoreVerifications.startedAt))
    .limit(1);
  return { lastRun: lastRun ?? null, lastPassed: lastPassed ?? null };
}
