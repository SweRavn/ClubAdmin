// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, schema, sql, type Tx } from "@clubadmin/db";

const { groups, groupOwners, seasons, groupSeasons } = schema;

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
