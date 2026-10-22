// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { backupWarnings, DEFAULT_BACKUP_THRESHOLDS } from "./backup-status.ts";

const now = new Date("2026-10-22T12:00:00Z");
const kind = (lastSuccessAt: string | null, lastRunStatus: string | null = "succeeded") => ({
  lastSuccessAt,
  lastLabel: null,
  lastRunAt: lastSuccessAt,
  lastRunStatus,
  sizeBytes: null,
});
const healthy = {
  backupsEnabled: true,
  database: kind("2026-10-22T02:00:00Z"),
  monthly: kind("2026-10-01T03:30:00Z"),
  files: kind("2026-10-22T11:17:00Z"),
  ledger: kind("2026-10-22T11:17:00Z"),
  verification: {
    lastPassedAt: "2026-10-19T05:00:00Z",
    lastRunAt: "2026-10-19T05:00:00Z",
    lastRunStatus: "passed",
    label: null,
    checks: [],
  },
};

describe("backupWarnings", () => {
  it("has none for a healthy installation", () => {
    expect(backupWarnings(healthy, DEFAULT_BACKUP_THRESHOLDS, now)).toEqual([]);
  });

  it("warns at the thresholds (24 h backups, 3 h files, 8 days verification)", () => {
    expect(
      backupWarnings(
        {
          ...healthy,
          database: kind("2026-10-21T11:59:00Z"),
          files: kind("2026-10-22T08:00:00Z", "failed"),
          verification: {
            ...healthy.verification,
            lastPassedAt: "2026-10-14T11:00:00Z",
            lastRunStatus: "failed",
          },
        },
        DEFAULT_BACKUP_THRESHOLDS,
        now,
      ),
    ).toEqual([
      "database_backup_stale",
      "files_backup_stale",
      "files_backup_failed",
      "restore_verification_stale",
      "restore_verification_failed",
    ]);
  });

  it("says when backups are off or never ran; no file warnings without file replication", () => {
    expect(
      backupWarnings(
        {
          ...healthy,
          backupsEnabled: false,
          database: kind(null, null),
          files: { ...kind(null, null), lastRunAt: null },
          verification: {
            lastPassedAt: null,
            lastRunAt: null,
            lastRunStatus: null,
            label: null,
            checks: [],
          },
        },
        DEFAULT_BACKUP_THRESHOLDS,
        now,
      ),
    ).toEqual(["backups_disabled", "database_never_backed_up", "restore_never_verified"]);
  });
});
