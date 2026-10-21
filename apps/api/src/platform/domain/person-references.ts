// SPDX-License-Identifier: AGPL-3.0-only
// How a module's rows follow a person when duplicates are merged
// (person-merge module). Each module that stores person references declares
// them next to its tables and exports them from its index.ts, so the merge
// covers every table without reaching into other modules' internals.

export interface OpenRowRule {
  /** SQL condition for open (current) rows; `{a}` is replaced by the table alias. */
  where: string;
  /** Columns that, with the person column, identify one open relationship. */
  key: readonly string[];
  /**
   * Column values (SQL) that end the duplicate's open row when the kept person
   * already has the same open relationship, or null to leave such rows with
   * the duplicate (rows that cannot end, such as club profiles).
   */
  end: Readonly<Record<string, string>> | null;
  /** Columns to restore when a merge is undone. */
  restore: readonly string[];
}

export interface PersonReference {
  /** Schema-qualified table, e.g. "public.club_memberships". */
  table: string;
  /** The column holding the person ID. */
  column: string;
  /** Club-owned table (moved club by club) or global. */
  clubScoped: boolean;
  /** For tables with at most one open row per person and key. */
  open?: OpenRowRule;
  /**
   * On undo, restore rows matching this condition (`{a}` = alias) first:
   * for tables whose row-level security depends on the rows themselves
   * (guardianships: the actor's own guardianship grants access to the others).
   */
  restoreFirst?: string;
}

const IDENTIFIER = /^[a-z_]+(\.[a-z_]+)?$/;

/** References are compiled into SQL; reject anything but plain identifiers. */
export function assertSafeReference(ref: PersonReference): void {
  for (const name of [
    ref.table,
    ref.column,
    ...(ref.open?.key ?? []),
    ...(ref.open?.restore ?? []),
  ]) {
    if (!IDENTIFIER.test(name)) throw new Error(`unsafe identifier in person reference: ${name}`);
  }
}
