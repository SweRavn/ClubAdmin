// SPDX-License-Identifier: AGPL-3.0-only
// Flags migration statements that are unsafe on a live database unless done
// with the expand/contract pattern (CLAUDE.md rule 13). Warnings only; silence
// one with a comment on the line before:  -- expand-contract: <reason>

import type { MigrationFile } from "./migrate.ts";

export interface MigrationWarning {
  file: string;
  line: number;
  message: string;
}

const RULES: [RegExp, string][] = [
  [
    /\bDROP\s+COLUMN\b/i,
    "drops a column: first stop using it in the code (expand), drop it in a later release (contract)",
  ],
  [
    /\bRENAME\s+COLUMN\b/i,
    "renames a column: add the new column, copy data, switch the code, then drop the old one",
  ],
  [
    /\bALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/i,
    "renames a table: running code still uses the old name",
  ],
  [
    /\bALTER\s+COLUMN\b[^;]*\b(SET\s+DATA\s+)?TYPE\b/i,
    "changes a column type: may rewrite the table and break running code",
  ],
  [/\bDROP\s+TABLE\b/i, "drops a table: make sure no running code uses it"],
  [
    /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i,
    "adds NOT NULL: backfill first, and consider a CHECK constraint NOT VALID",
  ],
];

export function lintMigrations(files: readonly MigrationFile[]): MigrationWarning[] {
  const warnings: MigrationWarning[] = [];
  for (const file of files) {
    const lines = file.sql.split("\n");
    lines.forEach((text, index) => {
      if (/^\s*--/.test(text)) return;
      const previous = lines[index - 1] ?? "";
      if (/--\s*expand-contract:\s*\S/i.test(previous) || /--\s*expand-contract:\s*\S/i.test(text))
        return;
      for (const [pattern, message] of RULES) {
        if (pattern.test(text)) warnings.push({ file: file.name, line: index + 1, message });
      }
    });
  }
  return warnings;
}
