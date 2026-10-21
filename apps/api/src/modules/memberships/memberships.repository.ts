// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { GroupFunction } from "@clubadmin/shared";

const { clubMemberships, groupMemberships } = schema;

export type ClubMembershipRow = typeof clubMemberships.$inferSelect;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;

export async function insertMembership(
  tx: Tx,
  values: typeof clubMemberships.$inferInsert,
): Promise<ClubMembershipRow> {
  const [row] = await tx.insert(clubMemberships).values(values).returning();
  return row!;
}

export async function findOpenMembership(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ClubMembershipRow | null> {
  const [row] = await tx
    .select()
    .from(clubMemberships)
    .where(
      and(
        eq(clubMemberships.clubId, clubId),
        eq(clubMemberships.personId, personId),
        isNull(clubMemberships.validTo),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function findMembership(tx: Tx, id: string): Promise<ClubMembershipRow | null> {
  const [row] = await tx
    .select()
    .from(clubMemberships)
    .where(eq(clubMemberships.id, id))
    .for("update");
  return row ?? null;
}

export async function updateMembership(
  tx: Tx,
  id: string,
  values: Partial<typeof clubMemberships.$inferInsert>,
): Promise<void> {
  await tx.update(clubMemberships).set(values).where(eq(clubMemberships.id, id));
}

export async function insertGroupMembership(
  tx: Tx,
  values: typeof groupMemberships.$inferInsert,
): Promise<GroupMembershipRow> {
  const [row] = await tx.insert(groupMemberships).values(values).returning();
  return row!;
}

export async function findGroupMembership(tx: Tx, id: string): Promise<GroupMembershipRow | null> {
  const [row] = await tx
    .select()
    .from(groupMemberships)
    .where(eq(groupMemberships.id, id))
    .for("update");
  return row ?? null;
}

export async function endGroupMembership(tx: Tx, id: string): Promise<void> {
  await tx
    .update(groupMemberships)
    .set({ validTo: sql`now()` })
    .where(eq(groupMemberships.id, id));
}

/** Ends all open group memberships of a person in the club; returns their IDs. */
export async function endGroupMembershipsOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<string[]> {
  const ended = await tx
    .update(groupMemberships)
    .set({ validTo: sql`now()` })
    .where(
      and(
        eq(groupMemberships.clubId, clubId),
        eq(groupMemberships.personId, personId),
        isNull(groupMemberships.validTo),
      ),
    )
    .returning({ id: groupMemberships.id });
  return ended.map((r) => r.id);
}

/** "Members of group": active rows, served by group_memberships_group_idx. */
export function groupMembersQuery(tx: Tx, clubId: string, groupId: string) {
  return tx
    .select({
      id: groupMemberships.id,
      personId: groupMemberships.personId,
      function: groupMemberships.function,
    })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.clubId, clubId),
        eq(groupMemberships.groupId, groupId),
        isNull(groupMemberships.validTo),
      ),
    )
    .orderBy(groupMemberships.id);
}

/** "My clubs" (by person, across clubs): club_memberships_person_active_idx. */
export function clubsOfPersonQuery(tx: Tx, personId: string) {
  return tx
    .select({
      clubId: clubMemberships.clubId,
      membershipId: clubMemberships.id,
      status: clubMemberships.status,
    })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.personId, personId), isNull(clubMemberships.validTo)))
    .orderBy(clubMemberships.clubId);
}

/** "My groups" (by person, across clubs): group_memberships_person_idx. */
export function groupsOfPersonQuery(tx: Tx, personId: string) {
  return tx
    .select({
      clubId: groupMemberships.clubId,
      groupId: groupMemberships.groupId,
      function: groupMemberships.function,
    })
    .from(groupMemberships)
    .where(and(eq(groupMemberships.personId, personId), isNull(groupMemberships.validTo)))
    .orderBy(groupMemberships.groupId);
}

export async function activeMemberIds(tx: Tx, clubId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: clubMemberships.personId })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), isNull(clubMemberships.validTo)));
  return rows.map((r) => r.personId);
}

export type GroupMember = { id: string; personId: string; function: GroupFunction };
