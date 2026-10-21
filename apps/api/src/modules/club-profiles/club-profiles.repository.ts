// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, schema, sql, type Tx } from "@clubadmin/db";

const { clubProfiles } = schema;

export type ClubProfileRow = typeof clubProfiles.$inferSelect;

export async function findProfile(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ClubProfileRow | null> {
  const [row] = await tx
    .select()
    .from(clubProfiles)
    .where(and(eq(clubProfiles.clubId, clubId), eq(clubProfiles.personId, personId)));
  return row ?? null;
}

/** The member number is assigned by the assign_member_number trigger. */
export async function insertProfile(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ClubProfileRow> {
  const [row] = await tx.insert(clubProfiles).values({ clubId, personId }).returning();
  return row!;
}

export async function updateProfile(
  tx: Tx,
  id: string,
  values: Partial<typeof clubProfiles.$inferInsert>,
): Promise<void> {
  await tx.update(clubProfiles).set(values).where(eq(clubProfiles.id, id));
}

export async function actorIsClubManager(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT app.is_club_manager() AS ok`);
  return rows[0]?.ok === true;
}
