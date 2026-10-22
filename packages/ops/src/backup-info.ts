// SPDX-License-Identifier: AGPL-3.0-only
// pgBackRest's `info --output=json`: which backup a restore starts from.

export interface BackupInfoEntry {
  label: string;
  type: string;
  /** Unix seconds. */
  start: number;
  stop: number;
}

export function parseBackupInfo(json: string): BackupInfoEntry[] {
  const stanzas = JSON.parse(json) as {
    backup?: { label: string; type: string; timestamp: { start: number; stop: number } }[];
  }[];
  return (stanzas[0]?.backup ?? [])
    .map((b) => ({
      label: b.label,
      type: b.type,
      start: b.timestamp.start,
      stop: b.timestamp.stop,
    }))
    .sort((a, b) => a.stop - b.stop);
}

/** The backup pgBackRest restores from: the latest, or the latest finished before `time`. */
export function backupFor(
  entries: readonly BackupInfoEntry[],
  time?: Date,
): BackupInfoEntry | null {
  const limit = time ? time.getTime() / 1000 : Number.POSITIVE_INFINITY;
  return entries.filter((b) => b.stop <= limit).at(-1) ?? null;
}
