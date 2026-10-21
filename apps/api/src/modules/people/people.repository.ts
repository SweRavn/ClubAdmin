// SPDX-License-Identifier: AGPL-3.0-only
// Queries on people. Row-level security limits every query to people the
// actor may reach (the person, their family, the current club's members).

import { eq, inArray, schema, sql, type Tx } from "@clubadmin/db";

const { people } = schema;

export type PersonRow = typeof people.$inferSelect;
export type NewPersonRow = typeof people.$inferInsert;

export async function insertPerson(tx: Tx, values: NewPersonRow): Promise<void> {
  await tx.insert(people).values(values);
}

export async function findPeople(tx: Tx, ids: readonly string[]): Promise<PersonRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(people)
    .where(inArray(people.id, [...ids]));
}

/** What the person presenter needs (names and the global protected flag). */
export async function findSummaries(tx: Tx, ids: readonly string[]): Promise<PersonSummaryRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: people.id,
      givenName: people.givenName,
      familyName: people.familyName,
      protectedIdentity: people.protectedIdentity,
    })
    .from(people)
    .where(inArray(people.id, [...ids]));
}

export interface PersonSummaryRow {
  id: string;
  givenName: string;
  familyName: string;
  protectedIdentity: boolean;
}

export async function findPerson(tx: Tx, id: string): Promise<PersonRow | null> {
  const [row] = await tx.select().from(people).where(eq(people.id, id));
  return row ?? null;
}

/** Locks the row for an update in this transaction. */
export async function lockPerson(tx: Tx, id: string): Promise<PersonRow | null> {
  const [row] = await tx.select().from(people).where(eq(people.id, id)).for("update");
  return row ?? null;
}

export async function updatePerson(
  tx: Tx,
  id: string,
  values: Partial<NewPersonRow>,
): Promise<void> {
  await tx.update(people).set(values).where(eq(people.id, id));
}

/** The current actor is a parent or legal guardian of the person (database helper). */
export async function actorIsFullGuardianOf(tx: Tx, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.is_full_guardian_of(${personId}) AS ok`,
  );
  return rows[0]?.ok === true;
}
