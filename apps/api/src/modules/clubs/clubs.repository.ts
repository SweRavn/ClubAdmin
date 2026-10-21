// SPDX-License-Identifier: AGPL-3.0-only
import { eq, inArray, schema, type Tx } from "@clubadmin/db";

const { clubs } = schema;

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
