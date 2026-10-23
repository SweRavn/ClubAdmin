// SPDX-License-Identifier: AGPL-3.0-only
// Queries on people. Row-level security limits every query to people the
// actor may reach (the person, their family, the current club's members).

import { eq, inArray, schema, sql, type Tx } from "@clubadmin/db";

const { people } = schema;

export type PersonRow = typeof people.$inferSelect;
export type NewPersonRow = typeof people.$inferInsert;

export async function insertPerson(tx: Tx, values: NewPersonRow): Promise<PersonRow> {
  const [row] = await tx.insert(people).values(values).returning();
  return row!;
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

/** A person of a file to compare with the club's people (adding and importing members, P1.3b). */
export interface ClubMatchCandidate {
  key: number;
  pinHash: string | null;
  birthDate: string | null;
  /** Lower-cased and trimmed. */
  given: string;
  family: string;
}

export interface ClubMatch {
  key: number;
  personId: string;
  /** Same identity number, or the same names and birth date (no conflicting number). */
  exact: boolean;
}

/**
 * People with a profile in the club (members, also former ones) that match
 * the candidates: the same identity number (people_pin_hash_idx), or the
 * same birth date and family or given name. Only the club's own people are
 * compared (never people outside it); hash joins over the club's people,
 * whatever the number of candidates.
 */
export async function clubMatches(
  tx: Tx,
  clubId: string,
  candidates: readonly ClubMatchCandidate[],
): Promise<ClubMatch[]> {
  if (candidates.length === 0) return [];
  const { rows } = await tx.execute<{ key: number; person_id: string; exact: boolean }>(sql`
    WITH c AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(
        candidates.map((c) => ({
          key: c.key,
          pin: c.pinHash,
          birth: c.birthDate,
          given: c.given,
          family: c.family,
        })),
      )}::jsonb) AS c(key int, pin text, birth date, given text, family text)
    ), members AS MATERIALIZED (
      SELECT p.id, p.birth_date, lower(p.given_name) AS given, lower(p.family_name) AS family,
        p.personal_identity_number_hash AS pin
      FROM public.club_profiles cp JOIN public.people p ON p.id = cp.person_id
      WHERE cp.club_id = ${clubId} AND p.merged_into_person_id IS NULL AND p.anonymized_at IS NULL
    ), found AS (
      SELECT c.key, m.id, true AS exact FROM c JOIN members m ON m.pin = c.pin
      UNION ALL
      SELECT c.key, m.id,
        (c.pin IS NULL OR m.pin IS NULL) AND m.given = c.given AS exact
      FROM c JOIN members m ON m.birth_date = c.birth AND m.family = c.family
      UNION ALL
      SELECT c.key, m.id, false FROM c JOIN members m ON m.birth_date = c.birth AND m.given = c.given
    )
    SELECT key, id AS person_id, bool_or(exact) AS exact FROM found
    GROUP BY key, id ORDER BY key, bool_or(exact) DESC, id`);
  return rows.map((r) => ({ key: r.key, personId: r.person_id, exact: r.exact }));
}

/**
 * The club's people with exactly these names and phone number (a guardian
 * in a file who is already in the club). Lower-cased names; phones compared
 * by their digits.
 */
export async function clubPeopleByNameAndPhone(
  tx: Tx,
  clubId: string,
  candidates: readonly { key: number; given: string; family: string; phone: string }[],
): Promise<{ key: number; personId: string }[]> {
  if (candidates.length === 0) return [];
  const { rows } = await tx.execute<{ key: number; person_id: string }>(sql`
    WITH c AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(
        candidates.map((c) => ({ ...c, phone: c.phone.replace(/[^0-9]/g, "") })),
      )}::jsonb) AS c(key int, given text, family text, phone text)
    )
    SELECT c.key, p.id AS person_id
    FROM c
    JOIN public.people p ON lower(p.given_name) = c.given AND lower(p.family_name) = c.family
      AND regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = c.phone
    JOIN public.club_profiles cp ON cp.person_id = p.id AND cp.club_id = ${clubId}
    WHERE p.merged_into_person_id IS NULL AND p.anonymized_at IS NULL AND c.phone <> ''`);
  return rows.map((r) => ({ key: r.key, personId: r.person_id }));
}
