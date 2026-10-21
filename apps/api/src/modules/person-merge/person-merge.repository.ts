// SPDX-License-Identifier: AGPL-3.0-only
// Generic SQL for moving person references (declared by the owning modules)
// from a duplicate to the kept person, and back on undo. Identifiers come from
// constant declarations, checked by assertSafeReference.

import { eq, schema, sql, type Tx } from "@clubadmin/db";

import {
  assertSafeReference,
  type PersonReference,
} from "../../platform/domain/person-references.ts";

const { peopleMerges } = schema;
export type MergeRow = typeof peopleMerges.$inferSelect;
export type MovedReference = schema.MovedReference;

const raw = (text: string) => sql.raw(text);
const aliased = (where: string, alias: string) => raw(where.replaceAll("{a}", alias));

/** Clubs in which the duplicate has rows visible to this transaction. */
export async function clubsWithReferences(
  tx: Tx,
  refs: readonly PersonReference[],
  personId: string,
): Promise<string[]> {
  const clubTables = refs.filter((r) => r.clubScoped);
  if (clubTables.length === 0) return [];
  const parts = clubTables.map((r) => {
    assertSafeReference(r);
    return sql`SELECT club_id FROM ${raw(r.table)} WHERE ${raw(r.column)} = ${personId}`;
  });
  const { rows } = await tx.execute<{ club_id: string }>(
    sql`SELECT DISTINCT club_id FROM (${sql.join(parts, sql` UNION `)}) AS c ORDER BY club_id`,
  );
  return rows.map((r) => r.club_id);
}

const idArray = (ids: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[]`;

/**
 * Moves one table's references; returns what was moved (and ended) for undo.
 * One UPDATE per table: row-level security is evaluated against the
 * statement's snapshot, so ending the actor's own guardianship of the
 * duplicate cannot hide the other rows halfway through.
 */
export async function moveReferences(
  tx: Tx,
  ref: PersonReference,
  fromPersonId: string,
  toPersonId: string,
  clubId: string | null,
): Promise<MovedReference[]> {
  assertSafeReference(ref);
  const table = raw(ref.table);
  const column = raw(ref.column);
  const conflicts: { id: string; previous: Record<string, unknown> }[] = [];

  if (ref.open) {
    const keyMatch = ref.open.key.length
      ? sql.join(
          ref.open.key.map((k) => raw(`k.${k} = d.${k}`)),
          sql` AND `,
        )
      : sql`true`;
    const restore = ref.open.restore.length
      ? sql`jsonb_build_object(${sql.join(
          ref.open.restore.map((c) => sql`${c}::text, ${raw(`d.${c}`)}`),
          sql`, `,
        )})`
      : sql`'{}'::jsonb`;
    const { rows } = await tx.execute<{ id: string; previous: Record<string, unknown> }>(sql`
      SELECT d.id, ${restore} AS previous FROM ${table} AS d
      WHERE d.${column} = ${fromPersonId} AND (${aliased(ref.open.where, "d")})
        AND EXISTS (
          SELECT 1 FROM ${table} AS k
          WHERE k.${column} = ${toPersonId} AND (${aliased(ref.open.where, "k")}) AND ${keyMatch}
        )
      FOR UPDATE OF d`);
    conflicts.push(...rows);
  }

  const conflictIds = conflicts.map((r) => r.id);
  const end = ref.open?.end;
  const assignments = [
    sql`${column} = ${toPersonId}`,
    ...Object.entries(end ?? {}).map(
      ([c, value]) =>
        sql`${raw(c)} = CASE WHEN d.id = ANY (${idArray(conflictIds)}) THEN ${raw(value)} ELSE d.${raw(c)} END`,
    ),
  ];
  // Rows that cannot end (end: null) stay with the duplicate when they conflict.
  const keep = end === null ? sql`AND d.id <> ALL (${idArray(conflictIds)})` : sql``;
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE ${table} AS d SET ${sql.join(assignments, sql`, `)}
    WHERE d.${column} = ${fromPersonId} ${keep}
    RETURNING d.id`);

  const previous = new Map(conflicts.map((r) => [r.id, r.previous]));
  return rows.map((row) =>
    previous.has(row.id) && end
      ? {
          table: ref.table,
          column: ref.column,
          id: row.id,
          clubId,
          action: "ended" as const,
          previous: previous.get(row.id)!,
        }
      : { table: ref.table, column: ref.column, id: row.id, clubId, action: "moved" as const },
  );
}

/** Moves recorded references back to the duplicate, restoring ended rows. Returns how many rows it changed. */
export async function restoreReferences(
  tx: Tx,
  ref: PersonReference,
  items: readonly MovedReference[],
  personId: string,
): Promise<number> {
  assertSafeReference(ref);
  if (items.length === 0) return 0;
  const table = raw(ref.table);
  const assignments = [
    sql`${raw(ref.column)} = ${personId}`,
    ...(ref.open?.restore ?? []).map(
      (c) =>
        sql`${raw(c)} = CASE WHEN r.action = 'ended' THEN (jsonb_populate_record(NULL::${table}, r.previous)).${raw(c)} ELSE t.${raw(c)} END`,
    ),
  ];
  const data = JSON.stringify(
    items.map((i) => ({ id: i.id, action: i.action, previous: i.previous ?? {} })),
  );
  const update = async (condition: ReturnType<typeof sql>) => {
    const { rowCount } = await tx.execute(sql`
      UPDATE ${table} AS t SET ${sql.join(assignments, sql`, `)}
      FROM jsonb_to_recordset(${data}::jsonb) AS r(id uuid, action text, previous jsonb)
      WHERE t.id = r.id AND ${condition}`);
    return rowCount ?? 0;
  };
  if (!ref.restoreFirst) return update(sql`true`);
  const first = aliased(ref.restoreFirst, "t");
  return (await update(first)) + (await update(sql`NOT (${first})`));
}

export async function insertMerge(
  tx: Tx,
  values: typeof peopleMerges.$inferInsert,
): Promise<MergeRow> {
  const [row] = await tx.insert(peopleMerges).values(values).returning();
  return row!;
}

export async function lockMerge(tx: Tx, id: string): Promise<MergeRow | null> {
  const [row] = await tx.select().from(peopleMerges).where(eq(peopleMerges.id, id)).for("update");
  return row ?? null;
}

export async function markUndone(tx: Tx, id: string, by: string): Promise<void> {
  await tx
    .update(peopleMerges)
    .set({ undoneAt: new Date(), undoneByPersonId: by })
    .where(eq(peopleMerges.id, id));
}

export async function hasAccount(tx: Tx, personId: string): Promise<boolean> {
  // Accounts are visible only to their own person; ask the database without revealing anything else.
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.person_has_account(${personId}) AS ok`,
  );
  return rows[0]?.ok === true;
}

export async function actorIsFullGuardianOfBoth(tx: Tx, a: string, b: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.is_full_guardian_of(${a}) AND app.is_full_guardian_of(${b}) AS ok`,
  );
  return rows[0]?.ok === true;
}

export async function actorIsClubManager(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT app.is_club_manager() AS ok`);
  return rows[0]?.ok === true;
}
