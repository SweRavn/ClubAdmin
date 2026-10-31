// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { WaitlistStatus } from "@clubadmin/shared";

const { groups, groupOwners, seasons, groupSeasons, groupWaitlistEntries } = schema;

export type GroupRow = typeof groups.$inferSelect;
export type NewGroupRow = typeof groups.$inferInsert;
export type GroupOwnerRow = typeof groupOwners.$inferSelect;
export type SeasonRow = typeof seasons.$inferSelect;

export async function insertGroup(tx: Tx, values: NewGroupRow): Promise<GroupRow> {
  const [row] = await tx.insert(groups).values(values).returning();
  return row!;
}

export async function findGroup(tx: Tx, id: string): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.id, id));
  return row ?? null;
}

export async function findGroups(tx: Tx, ids: readonly string[]): Promise<GroupRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(groups)
    .where(inArray(groups.id, [...ids]));
}

export async function endOwnershipsOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<string[]> {
  const rows = await tx
    .update(groupOwners)
    .set({ validTo: sql`now()` })
    .where(
      and(
        eq(groupOwners.clubId, clubId),
        eq(groupOwners.personId, personId),
        isNull(groupOwners.validTo),
      ),
    )
    .returning({ id: groupOwners.id });
  return rows.map((r) => r.id);
}

export async function lockGroup(tx: Tx, id: string): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.id, id)).for("update");
  return row ?? null;
}

export async function updateGroup(tx: Tx, id: string, values: Partial<NewGroupRow>): Promise<void> {
  await tx.update(groups).set(values).where(eq(groups.id, id));
}

export async function deleteGroup(tx: Tx, id: string): Promise<void> {
  await tx.delete(groups).where(eq(groups.id, id));
}

/** Child groups that are not archived. */
export async function hasActiveChildren(tx: Tx, id: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM public.groups WHERE parent_group_id = ${id} AND archived_at IS NULL LIMIT 1`);
  return rows.length > 0;
}

/**
 * Whether anything refers to the group (P1.6b): the tables whose foreign keys
 * keep a group from being deleted (none cascades). Reads only whether rows
 * exist, never their content; the delete itself relies on the keys.
 */
export async function isInUse(tx: Tx, id: string): Promise<boolean> {
  const { rows } = await tx.execute<{ used: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.group_memberships WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.group_owners WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.group_seasons WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.groups WHERE parent_group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.group_waitlist_entries WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.invitations WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.activity_groups WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.activity_series_groups WHERE group_id = ${id})
      OR EXISTS (SELECT 1 FROM public.event_groups WHERE group_id = ${id}) AS used`);
  return rows[0]?.used ?? true;
}

/** The group and its ancestors, nearest first. */
export async function ancestorIds(tx: Tx, groupId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_group_id, 0 AS depth FROM public.groups WHERE id = ${groupId}
      UNION
      SELECT g.id, g.parent_group_id, up.depth + 1 FROM public.groups g JOIN up ON g.id = up.parent_group_id
    )
    SELECT id FROM up ORDER BY depth`);
  return rows.map((r) => r.id);
}

export async function insertOwner(
  tx: Tx,
  values: typeof groupOwners.$inferInsert,
): Promise<GroupOwnerRow> {
  const [row] = await tx.insert(groupOwners).values(values).returning();
  return row!;
}

export async function activeOwners(tx: Tx, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: groupOwners.personId })
    .from(groupOwners)
    .where(and(eq(groupOwners.groupId, groupId), isNull(groupOwners.validTo)));
  return rows.map((r) => r.personId);
}

/** Active owner of any of the groups. */
export async function isOwnerOfAny(tx: Tx, groupIds: string[], personId: string): Promise<boolean> {
  if (groupIds.length === 0) return false;
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.group_owners
      WHERE person_id = ${personId} AND valid_to IS NULL
        AND group_id = ANY (ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(groupIds)}::jsonb))::uuid[])
    ) AS ok`);
  return rows[0]?.ok === true;
}

export async function endOwner(tx: Tx, groupId: string, personId: string): Promise<string | null> {
  const [row] = await tx
    .update(groupOwners)
    .set({ validTo: sql`now()` })
    .where(
      and(
        eq(groupOwners.groupId, groupId),
        eq(groupOwners.personId, personId),
        isNull(groupOwners.validTo),
      ),
    )
    .returning({ id: groupOwners.id });
  return row?.id ?? null;
}

export async function insertSeason(
  tx: Tx,
  values: typeof seasons.$inferInsert,
): Promise<SeasonRow> {
  const [row] = await tx.insert(seasons).values(values).returning();
  return row!;
}

export async function upsertGroupSeason(
  tx: Tx,
  values: typeof groupSeasons.$inferInsert,
): Promise<string> {
  const [row] = await tx
    .insert(groupSeasons)
    .values(values)
    .onConflictDoUpdate({
      target: [groupSeasons.groupId, groupSeasons.seasonId],
      set: { capacity: values.capacity ?? null, notes: values.notes ?? null },
    })
    .returning({ id: groupSeasons.id });
  return row!.id;
}

/**
 * A page of the club's groups ordered by name (keyset: name, id); archived
 * groups only if asked. Served by groups_club_idx. cursorFound is false when
 * the cursor is not a group of the club.
 */
export async function listGroupsPage(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number; includeArchived: boolean },
): Promise<{ rows: GroupRow[]; cursorFound: boolean }> {
  let anchor: { name: string; id: string } | undefined;
  if (page.cursor) {
    [anchor] = await tx
      .select({ name: groups.name, id: groups.id })
      .from(groups)
      .where(and(eq(groups.clubId, clubId), eq(groups.id, page.cursor)));
    if (!anchor) return { rows: [], cursorFound: false };
  }
  const rows = await tx
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.clubId, clubId),
        page.includeArchived ? undefined : isNull(groups.archivedAt),
        anchor
          ? sql`(${groups.name}, ${groups.id}) > (${anchor.name}, ${anchor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(groups.name, groups.id)
    .limit(page.limit);
  return { rows, cursorFound: true };
}

export async function activeGroupNames(
  tx: Tx,
  clubId: string,
): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.clubId, clubId), isNull(groups.archivedAt)));
}

// --- My waiting lists (P1.6b) ----------------------------------------------

export interface OwnWaitlistEntry {
  id: string;
  clubId: string;
  groupId: string;
  personId: string;
  status: WaitlistStatus;
  queuedAt: Date;
  offerExpiresAt: Date | null;
}

/**
 * The open entries of the given people (the caller and their wards) in every
 * club: own_relationships, uses group_waitlist_entries_person_idx.
 */
export async function ownOpenWaitlistEntries(
  tx: Tx,
  personIds: readonly string[],
): Promise<OwnWaitlistEntry[]> {
  if (personIds.length === 0) return [];
  return tx
    .select({
      id: groupWaitlistEntries.id,
      clubId: groupWaitlistEntries.clubId,
      groupId: groupWaitlistEntries.groupId,
      personId: groupWaitlistEntries.personId,
      status: groupWaitlistEntries.status,
      queuedAt: groupWaitlistEntries.queuedAt,
      offerExpiresAt: groupWaitlistEntries.offerExpiresAt,
    })
    .from(groupWaitlistEntries)
    .where(
      and(
        inArray(groupWaitlistEntries.personId, [...personIds]),
        inArray(groupWaitlistEntries.status, ["waiting", "offered"]),
      ),
    )
    .orderBy(groupWaitlistEntries.queuedAt, groupWaitlistEntries.id)
    .limit(100);
}

export interface WaitlistQueue {
  position: number | null;
  waiting: number;
  groupName: string;
  clubName: string;
}

/**
 * Place in the queue (1 = next; null while an offer is out) and the number
 * waiting, in the transaction's club. Same order as the queue
 * (group_waitlist_entries_order_idx: priority first, then queued_at).
 */
export async function waitlistPositions(
  tx: Tx,
  entryIds: readonly string[],
): Promise<Map<string, WaitlistQueue>> {
  if (entryIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    id: string;
    position: number | null;
    waiting: number;
    group_name: string;
    club_name: string;
  }>(sql`
    SELECT e.id, g.name AS group_name, c.name AS club_name,
      CASE WHEN e.status = 'waiting' THEN (
        SELECT count(*)::int + 1 FROM public.group_waitlist_entries o
        WHERE o.group_id = e.group_id AND o.status = 'waiting'
          AND (o.priority > e.priority
            OR (o.priority = e.priority AND (o.queued_at, o.id) < (e.queued_at, e.id)))
      ) END AS position,
      (SELECT count(*)::int FROM public.group_waitlist_entries w
       WHERE w.group_id = e.group_id AND w.status = 'waiting') AS waiting
    FROM public.group_waitlist_entries e
    JOIN public.groups g ON g.club_id = e.club_id AND g.id = e.group_id
    JOIN public.clubs c ON c.id = e.club_id
    WHERE e.id IN (${sql.join(
      entryIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  return new Map(
    rows.map((r) => [
      r.id,
      { position: r.position, waiting: r.waiting, groupName: r.group_name, clubName: r.club_name },
    ]),
  );
}
