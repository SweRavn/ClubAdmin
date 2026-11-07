// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { WaitlistClosedReason } from "@clubadmin/shared";

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

/** The person's open group ownerships in the club. */
export async function ownershipsOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<{ id: string; groupId: string }[]> {
  return tx
    .select({ id: groupOwners.id, groupId: groupOwners.groupId })
    .from(groupOwners)
    .where(
      and(
        eq(groupOwners.clubId, clubId),
        eq(groupOwners.personId, personId),
        isNull(groupOwners.validTo),
      ),
    )
    .orderBy(groupOwners.groupId);
}

/** Ends one open ownership of the person by its ID; its group, or null. */
export async function endOwnershipOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
  id: string,
): Promise<string | null> {
  const [row] = await tx
    .update(groupOwners)
    .set({ validTo: sql`now()` })
    .where(
      and(
        eq(groupOwners.id, id),
        eq(groupOwners.clubId, clubId),
        eq(groupOwners.personId, personId),
        isNull(groupOwners.validTo),
      ),
    )
    .returning({ groupId: groupOwners.groupId });
  return row?.groupId ?? null;
}

/** Withdraws the person's open waiting-list entries in the club; their IDs. */
export async function withdrawWaitlistEntriesOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<string[]> {
  const rows = await tx
    .update(groupWaitlistEntries)
    .set({
      status: "withdrawn",
      closedReason: "left_club",
      decidedAt: sql`now()`,
      offerExpiresAt: null,
    })
    .where(
      and(
        eq(groupWaitlistEntries.clubId, clubId),
        eq(groupWaitlistEntries.personId, personId),
        inArray(groupWaitlistEntries.status, ["waiting", "offered", "accepted"]),
      ),
    )
    .returning({ id: groupWaitlistEntries.id });
  return rows.map((r) => r.id);
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

// --- P1.10a: capacity, seasons, archiving -----------------------------------------------

export interface GroupCapacity {
  /** This season's capacity of the group, else its own; null is unlimited. */
  capacity: number | null;
  /** Open `member` functions, outstanding offers and accepted entries (leaders never count). */
  occupied: number;
}

/**
 * The group's places today (app.group_places, one statement): the capacity of
 * the season covering today in the club's time zone, else the group's own;
 * occupied = open `member` functions, outstanding offers and accepted
 * waiting-list entries (P1.10b).
 */
export async function capacityOf(tx: Tx, groupId: string): Promise<GroupCapacity> {
  const { rows } = await tx.execute<{ capacity: number | null; occupied: number }>(
    sql`SELECT capacity, occupied FROM app.group_places(${groupId})`,
  );
  const row = rows[0];
  return { capacity: row?.capacity ?? null, occupied: row?.occupied ?? 0 };
}

/** People waiting for the group (the group page shows the number). */
export async function waitingCountOf(tx: Tx, groupId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.group_waitlist_entries
    WHERE group_id = ${groupId} AND status = 'waiting'`);
  return rows[0]?.n ?? 0;
}

/** The club's seasons, newest first. */
export async function listSeasons(tx: Tx, clubId: string): Promise<SeasonRow[]> {
  return tx
    .select()
    .from(seasons)
    .where(eq(seasons.clubId, clubId))
    .orderBy(sql`${seasons.startsOn} DESC`, seasons.id)
    .limit(100);
}

export async function findSeason(tx: Tx, id: string): Promise<SeasonRow | null> {
  const [row] = await tx.select().from(seasons).where(eq(seasons.id, id));
  return row ?? null;
}

/** The group's per-season settings. */
export async function groupSeasonsOf(
  tx: Tx,
  groupId: string,
): Promise<{ seasonId: string; capacity: number | null; notes: string | null }[]> {
  return tx
    .select({
      seasonId: groupSeasons.seasonId,
      capacity: groupSeasons.capacity,
      notes: groupSeasons.notes,
    })
    .from(groupSeasons)
    .where(eq(groupSeasons.groupId, groupId));
}

export async function activeChildrenCount(tx: Tx, id: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.groups WHERE parent_group_id = ${id} AND archived_at IS NULL`);
  return rows[0]?.n ?? 0;
}

const OPEN_WAITLIST = ["waiting", "offered", "accepted"] as const;

export async function openWaitlistCount(tx: Tx, groupId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.group_waitlist_entries
    WHERE group_id = ${groupId} AND status IN ('waiting', 'offered', 'accepted')`);
  return rows[0]?.n ?? 0;
}

/**
 * Closes the group's open waiting-list entries by the club (archiving):
 * `removed` with the reason, decided now by the actor. Their IDs.
 */
export async function closeOpenWaitlistEntries(
  tx: Tx,
  groupId: string,
  reason: WaitlistClosedReason,
  decidedBy: string | null,
): Promise<string[]> {
  const rows = await tx
    .update(groupWaitlistEntries)
    .set({
      status: "removed",
      closedReason: reason,
      decidedAt: sql`now()`,
      decidedByPersonId: decidedBy,
      offerExpiresAt: null,
    })
    .where(
      and(
        eq(groupWaitlistEntries.groupId, groupId),
        inArray(groupWaitlistEntries.status, [...OPEN_WAITLIST]),
      ),
    )
    .returning({ id: groupWaitlistEntries.id });
  return rows.map((r) => r.id);
}
