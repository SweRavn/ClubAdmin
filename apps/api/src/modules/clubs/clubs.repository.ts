// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq, inArray, schema, type Tx } from "@clubadmin/db";

const { clubs, clubPhoneNumbers } = schema;

export type PhoneNumberRow = typeof clubPhoneNumbers.$inferSelect;

export type ClubRow = typeof clubs.$inferSelect;
export type NewClubRow = typeof clubs.$inferInsert;

export async function insertClub(tx: Tx, values: NewClubRow): Promise<void> {
  await tx.insert(clubs).values(values);
}

export async function findClub(tx: Tx, id: string): Promise<ClubRow | null> {
  const [row] = await tx.select().from(clubs).where(eq(clubs.id, id));
  return row ?? null;
}

export async function findClubs(tx: Tx, ids: readonly string[]): Promise<ClubRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(clubs)
    .where(inArray(clubs.id, [...ids]));
}

/** Row lock serialising manager changes and member numbers of one club. */
export async function lockClub(tx: Tx, id: string): Promise<ClubRow | null> {
  const [row] = await tx.select().from(clubs).where(eq(clubs.id, id)).for("update");
  return row ?? null;
}

export async function updateClub(tx: Tx, id: string, values: Partial<NewClubRow>): Promise<void> {
  await tx.update(clubs).set(values).where(eq(clubs.id, id));
}

export async function listClubs(tx: Tx): Promise<ClubRow[]> {
  return tx.select().from(clubs).orderBy(clubs.name);
}

/** The club's phone numbers in the order shown (P1.6b). */
export async function phoneNumbers(tx: Tx, clubId: string): Promise<PhoneNumberRow[]> {
  return tx
    .select()
    .from(clubPhoneNumbers)
    .where(eq(clubPhoneNumbers.clubId, clubId))
    .orderBy(asc(clubPhoneNumbers.sortOrder));
}

/** Replaces the club's phone numbers (at most ten rows: delete and insert). */
export async function replacePhoneNumbers(
  tx: Tx,
  clubId: string,
  numbers: readonly { label: string; number: string }[],
): Promise<void> {
  await tx.delete(clubPhoneNumbers).where(eq(clubPhoneNumbers.clubId, clubId));
  if (numbers.length === 0) return;
  await tx
    .insert(clubPhoneNumbers)
    .values(numbers.map((n, i) => ({ clubId, label: n.label, number: n.number, sortOrder: i })));
}
