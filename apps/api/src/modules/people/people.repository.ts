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

/** People of duplicate candidates: names, the global protected flag and the birth date. */
export async function findDuplicatePeople(
  tx: Tx,
  ids: readonly string[],
): Promise<(PersonSummaryRow & { birthDate: string | null })[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: people.id,
      givenName: people.givenName,
      familyName: people.familyName,
      protectedIdentity: people.protectedIdentity,
      birthDate: people.birthDate,
    })
    .from(people)
    .where(inArray(people.id, [...ids]));
}

export interface DuplicatePair {
  personId: string;
  duplicatePersonId: string;
  birthDate: string | null;
  reason: "name_and_birth_date" | "personal_identity_number";
}

/**
 * Pairs of the club's members that look like the same person, keyset-paged
 * by (person, duplicate): same birth date and family name
 * (people_duplicate_idx) or the same personal identity number
 * (people_pin_hash_idx), each pair once.
 */
export function clubDuplicatesQuery(
  clubId: string,
  options: { after: [string, string] | null; limit: number },
) {
  const after = options.after
    ? sql`AND (c.person_id, c.duplicate_person_id) > (${options.after[0]}::uuid, ${options.after[1]}::uuid)`
    : sql``;
  return sql`
    WITH members AS MATERIALIZED (
      SELECT p.id, p.birth_date, lower(p.family_name) AS family, p.personal_identity_number_hash AS pin
      FROM public.club_profiles cp JOIN public.people p ON p.id = cp.person_id
      WHERE cp.club_id = ${clubId} AND p.merged_into_person_id IS NULL AND p.anonymized_at IS NULL
    ), candidates AS (
      SELECT a.id AS person_id, b.id AS duplicate_person_id, a.birth_date, 'name_and_birth_date' AS reason
      FROM members a JOIN members b
        ON b.birth_date = a.birth_date AND b.family = a.family AND b.id > a.id
      UNION ALL
      SELECT a.id, b.id, a.birth_date, 'personal_identity_number'
      FROM members a JOIN members b ON b.pin = a.pin AND b.id > a.id
      WHERE a.pin IS NOT NULL
    )
    SELECT DISTINCT ON (c.person_id, c.duplicate_person_id)
      c.person_id, c.duplicate_person_id, c.birth_date, c.reason
    FROM candidates c
    WHERE true ${after}
    ORDER BY c.person_id, c.duplicate_person_id, c.reason DESC
    LIMIT ${options.limit}`;
}

export async function clubDuplicates(
  tx: Tx,
  clubId: string,
  options: { after: [string, string] | null; limit: number },
): Promise<DuplicatePair[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    duplicate_person_id: string;
    birth_date: string | null;
    reason: DuplicatePair["reason"];
  }>(clubDuplicatesQuery(clubId, options));
  return rows.map((r) => ({
    personId: r.person_id,
    duplicatePersonId: r.duplicate_person_id,
    birthDate: r.birth_date,
    reason: r.reason,
  }));
}
