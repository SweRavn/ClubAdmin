// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, schema, sql, type Tx } from "@clubadmin/db";

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
  init: ProfileInit = {},
): Promise<ClubProfileRow> {
  const [row] = await tx
    .insert(clubProfiles)
    .values({ clubId, personId, ...init })
    .returning();
  return row!;
}

/** Values of a new profile (adding and importing members, P1.3b). */
export interface ProfileInit {
  /** A kept member number (else the running number). */
  memberNumber?: number;
  sharedFields?: (typeof clubProfiles.$inferInsert)["sharedFields"];
  protectedIdentityClub?: boolean;
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

export async function takenMemberNumbers(
  tx: Tx,
  clubId: string,
  numbers: readonly number[],
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  const rows = await tx
    .select({ memberNumber: clubProfiles.memberNumber })
    .from(clubProfiles)
    .where(and(eq(clubProfiles.clubId, clubId), inArray(clubProfiles.memberNumber, [...numbers])));
  return new Set(rows.map((r) => r.memberNumber));
}

/** The club's running member number (clubs.next_member_number, used by assign_member_number). */
export async function reserveMemberNumbers(tx: Tx, clubId: string, count: number): Promise<number> {
  const { rows } = await tx.execute<{ first: number }>(sql`
    UPDATE public.clubs SET next_member_number = next_member_number + ${count}
    WHERE id = ${clubId} RETURNING next_member_number - ${count} AS first`);
  if (!rows[0]) throw new Error("club not found in the current context");
  return rows[0].first;
}
