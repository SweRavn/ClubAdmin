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

/**
 * When a membership ending on `date` (in the club's time zone) ends: now for
 * today or no date, the end of an earlier day, null for a future day.
 */
/** The start of a calendar day in a time zone; null for a day after today there. */
export async function startOfDay(tx: Tx, date: string, timeZone: string): Promise<Date | null> {
  const { rows } = await tx.execute<{ start_at: string; future: boolean }>(sql`
    SELECT ${date}::date::timestamp AT TIME ZONE ${timeZone} AS start_at,
      ${date}::date > (now() AT TIME ZONE ${timeZone})::date AS future`);
  const row = rows[0]!;
  return row.future ? null : new Date(row.start_at);
}

export async function endOfDay(
  tx: Tx,
  date: string | null,
  timeZone: string,
): Promise<Date | null> {
  if (date === null) return new Date();
  const { rows } = await tx.execute<{ end_at: string; today: boolean; future: boolean }>(sql`
    SELECT (${date}::date + 1)::timestamp AT TIME ZONE ${timeZone} AS end_at,
      ${date}::date = (now() AT TIME ZONE ${timeZone})::date AS today,
      ${date}::date > (now() AT TIME ZONE ${timeZone})::date AS future`);
  const row = rows[0]!;
  if (row.future) return null;
  return row.today ? new Date() : new Date(row.end_at);
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

export interface GroupMembersPageRow {
  totalCount: number;
  cursorFound: boolean;
  items: { personId: string; functions: GroupFunction[] }[];
}

/**
 * One page of a group's roster, ordered by name, from app.visible_group_members
 * (protected persons are left out unless the transaction is viewerPrivileged,
 * ADR 0022), plus the total number of members as an aggregate. One statement;
 * served by group_memberships_group_idx. Returns IDs only.
 */
export async function groupMembersPage(
  tx: Tx,
  clubId: string,
  groupId: string,
  page: { cursor: string | null; limit: number },
): Promise<GroupMembersPageRow> {
  const { rows } = await tx.execute<{
    total_count: number;
    cursor_found: boolean;
    items: GroupMembersPageRow["items"];
  }>(groupMembersPageQuery(clubId, groupId, page));
  const row = rows[0]!;
  return { totalCount: row.total_count, cursorFound: row.cursor_found, items: row.items };
}

/** The statement of groupMembersPage (query-plans test). */
export function groupMembersPageQuery(
  clubId: string,
  groupId: string,
  page: { cursor: string | null; limit: number },
) {
  return sql`
    WITH anchor AS (
      SELECT v.sort_given_name, v.person_id FROM app.visible_group_members v
      WHERE v.club_id = ${clubId} AND v.group_id = ${groupId} AND v.person_id = ${page.cursor}
      LIMIT 1
    ), page AS (
      SELECT v.person_id, array_agg(v.function ORDER BY v.function) AS functions,
        row_number() OVER (ORDER BY v.sort_given_name, v.person_id) AS ord
      FROM app.visible_group_members v
      WHERE v.club_id = ${clubId} AND v.group_id = ${groupId}
        AND (${page.cursor}::uuid IS NULL
          OR (v.sort_given_name, v.person_id) > (SELECT a.sort_given_name, a.person_id FROM anchor a))
      GROUP BY v.person_id, v.sort_given_name
      ORDER BY v.sort_given_name, v.person_id
      LIMIT ${page.limit}
    )
    SELECT
      (SELECT count(DISTINCT gm.person_id)::int FROM public.group_memberships gm
       WHERE gm.club_id = ${clubId} AND gm.group_id = ${groupId} AND gm.valid_to IS NULL) AS total_count,
      (${page.cursor}::uuid IS NULL OR EXISTS (SELECT 1 FROM anchor)) AS cursor_found,
      coalesce((SELECT jsonb_agg(jsonb_build_object('personId', p.person_id, 'functions', p.functions) ORDER BY p.ord) FROM page p), '[]') AS items`;
}
