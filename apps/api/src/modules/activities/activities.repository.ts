// SPDX-License-Identifier: AGPL-3.0-only
// Queries on locations, activity series, activities, their groups and the
// calendars' read model (schedule_entries, ADR 0034). IDs only towards
// people: no query here reads names.

import { and, asc, eq, inArray, isNull, schema, type SQL, sql, type Tx } from "@clubadmin/db";

const { activities, activityGroups, activitySeries, activitySeriesGroups, groups, locations } =
  schema;

export type LocationRow = typeof locations.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type NewActivityRow = typeof activities.$inferInsert;
export type SeriesRow = typeof activitySeries.$inferSelect;

/** A uuid[] parameter (IDs only; validated as UUIDs where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

// --- Locations -----------------------------------------------------------------

export async function listLocations(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number; archived: boolean },
): Promise<LocationRow[]> {
  return tx
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.clubId, clubId),
        page.archived ? undefined : isNull(locations.archivedAt),
        page.cursor
          ? sql`(lower(${locations.name}), ${locations.id}) > (SELECT lower(l.name), l.id FROM public.locations l WHERE l.id = ${page.cursor})`
          : undefined,
      ),
    )
    .orderBy(sql`lower(${locations.name})`, asc(locations.id))
    .limit(page.limit);
}

export async function findLocations(tx: Tx, ids: readonly string[]): Promise<LocationRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(locations)
    .where(inArray(locations.id, [...ids]));
}

export async function insertLocation(
  tx: Tx,
  values: typeof locations.$inferInsert,
): Promise<LocationRow> {
  const [row] = await tx.insert(locations).values(values).returning();
  return row!;
}

export async function updateLocation(
  tx: Tx,
  id: string,
  values: Partial<typeof locations.$inferInsert>,
): Promise<LocationRow | null> {
  const [row] = await tx.update(locations).set(values).where(eq(locations.id, id)).returning();
  return row ?? null;
}

// --- Groups of the club ------------------------------------------------------------

/** The club's groups among these IDs, with whether they are archived. */
export async function clubGroups(
  tx: Tx,
  clubId: string,
  ids: readonly string[],
): Promise<{ id: string; name: string; archived: boolean }[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: groups.id, name: groups.name, archivedAt: groups.archivedAt })
    .from(groups)
    .where(and(eq(groups.clubId, clubId), inArray(groups.id, [...ids])));
  return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null }));
}

// --- Activities ------------------------------------------------------------------

export async function insertActivities(
  tx: Tx,
  rows: readonly NewActivityRow[],
): Promise<ActivityRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(activities)
    .values([...rows])
    .returning();
}

export async function insertActivityGroups(
  tx: Tx,
  clubId: string,
  activityIds: readonly string[],
  groupIds: readonly string[],
): Promise<void> {
  if (activityIds.length === 0 || groupIds.length === 0) return;
  await tx
    .insert(activityGroups)
    .values(
      activityIds.flatMap((activityId) =>
        groupIds.map((groupId) => ({ clubId, activityId, groupId })),
      ),
    );
}

export async function findActivity(tx: Tx, id: string): Promise<ActivityRow | null> {
  const [row] = await tx.select().from(activities).where(eq(activities.id, id));
  return row ?? null;
}

export async function lockActivity(tx: Tx, id: string): Promise<ActivityRow | null> {
  const [row] = await tx.select().from(activities).where(eq(activities.id, id)).for("update");
  return row ?? null;
}

export async function updateActivity(
  tx: Tx,
  id: string,
  values: Partial<NewActivityRow>,
): Promise<ActivityRow> {
  const [row] = await tx.update(activities).set(values).where(eq(activities.id, id)).returning();
  return row!;
}

export async function deleteActivities(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.delete(activities).where(inArray(activities.id, [...ids]));
}

/** The groups of these activities. */
export async function groupsOfActivities(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (activityIds.length === 0) return map;
  const rows = await tx
    .select({ activityId: activityGroups.activityId, id: groups.id, name: groups.name })
    .from(activityGroups)
    .innerJoin(groups, eq(groups.id, activityGroups.groupId))
    .where(inArray(activityGroups.activityId, [...activityIds]))
    .orderBy(asc(groups.name));
  for (const r of rows) {
    const list = map.get(r.activityId) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.activityId, list);
  }
  return map;
}

/**
 * Rewrites the read model of these activities (or of every activity at a
 * location): one row per activity and group with what calendars show. One
 * statement each for the delete and the insert.
 */
export async function syncScheduleEntries(
  tx: Tx,
  by: { activityIds: readonly string[] } | { locationId: string },
): Promise<void> {
  const where =
    "activityIds" in by
      ? sql`a.id = ANY (${uuidArray(by.activityIds)}::uuid[])`
      : sql`a.location_id = ${by.locationId}`;
  if ("activityIds" in by && by.activityIds.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.schedule_entries se USING public.activities a
    WHERE se.activity_id = a.id AND ${where}`);
  await tx.execute(sql`
    INSERT INTO public.schedule_entries (club_id, activity_id, group_id, kind, title, status,
      cancelled_reason, starts_at, ends_at, all_day, meet_at, place, changed_at, response_mode,
      respond_by)
    SELECT a.club_id, a.id, ag.group_id, a.kind, a.title, a.status, a.cancelled_reason,
      a.starts_at, a.ends_at, a.all_day, a.meet_at, coalesce(l.name, a.location_text), a.changed_at,
      a.response_mode, a.respond_by
    FROM public.activities a
    JOIN public.activity_groups ag ON ag.activity_id = a.id
    LEFT JOIN public.locations l ON l.id = a.location_id
    WHERE ${where}`);
}

/** A group's calendar: activity IDs in a range, through the read model's (group_id, starts_at) index. */
export function groupCalendarQuery(
  groupId: string,
  page: { from: Date; to: Date; cursor: string | null; limit: number },
): SQL {
  return sql`
    SELECT se.activity_id AS id FROM public.schedule_entries se
    WHERE se.group_id = ${groupId} AND se.starts_at >= ${page.from} AND se.starts_at < ${page.to}
      ${
        page.cursor
          ? sql`AND (se.starts_at, se.activity_id) > (SELECT c.starts_at, c.activity_id FROM public.schedule_entries c WHERE c.group_id = ${groupId} AND c.activity_id = ${page.cursor})`
          : sql``
      }
    ORDER BY se.starts_at, se.activity_id
    LIMIT ${page.limit}`;
}

export async function groupCalendar(
  tx: Tx,
  groupId: string,
  page: { from: Date; to: Date; cursor: string | null; limit: number },
): Promise<ActivityRow[]> {
  const { rows } = await tx.execute<{ id: string }>(groupCalendarQuery(groupId, page));
  return orderedActivities(
    tx,
    rows.map((r) => r.id),
  );
}

/** The club calendar: activity IDs in a range, optionally of a group or at a location. */
export function clubCalendarQuery(
  clubId: string,
  page: {
    from: Date;
    to: Date;
    groupId: string | null;
    locationId: string | null;
    cursor: string | null;
    limit: number;
  },
): SQL {
  return sql`
    SELECT a.id FROM public.activities a
    WHERE a.club_id = ${clubId} AND a.starts_at >= ${page.from} AND a.starts_at < ${page.to}
      ${page.locationId ? sql`AND a.location_id = ${page.locationId}` : sql``}
      ${
        page.groupId
          ? sql`AND EXISTS (SELECT 1 FROM public.activity_groups ag WHERE ag.activity_id = a.id AND ag.group_id = ${page.groupId})`
          : sql``
      }
      ${
        page.cursor
          ? sql`AND (a.starts_at, a.id) > (SELECT c.starts_at, c.id FROM public.activities c WHERE c.id = ${page.cursor})`
          : sql``
      }
    ORDER BY a.starts_at, a.id
    LIMIT ${page.limit}`;
}

export async function clubCalendar(
  tx: Tx,
  clubId: string,
  page: Parameters<typeof clubCalendarQuery>[1],
): Promise<ActivityRow[]> {
  const { rows } = await tx.execute<{ id: string }>(clubCalendarQuery(clubId, page));
  return orderedActivities(
    tx,
    rows.map((r) => r.id),
  );
}

async function orderedActivities(tx: Tx, ids: string[]): Promise<ActivityRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(activities).where(inArray(activities.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** Pairs of scheduled activities at the same location whose times overlap. */
export async function locationConflicts(
  tx: Tx,
  clubId: string,
  locationId: string,
  range: { from: Date; to: Date },
): Promise<[string, string][]> {
  const { rows } = await tx.execute<{ first: string; second: string }>(sql`
    SELECT a.id AS first, b.id AS second
    FROM public.activities a
    JOIN public.activities b ON b.club_id = a.club_id AND b.location_id = a.location_id
      AND b.id > a.id AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
      AND b.status = 'scheduled'
    WHERE a.club_id = ${clubId} AND a.location_id = ${locationId} AND a.status = 'scheduled'
      AND a.starts_at >= ${range.from} AND a.starts_at < ${range.to}
    ORDER BY a.starts_at, a.id, b.id
    LIMIT 200`);
  return rows.map((r) => [r.first, r.second]);
}

// --- Series ----------------------------------------------------------------------

export async function insertSeries(
  tx: Tx,
  values: typeof activitySeries.$inferInsert,
  groupIds: readonly string[],
): Promise<SeriesRow> {
  const [row] = await tx.insert(activitySeries).values(values).returning();
  await tx
    .insert(activitySeriesGroups)
    .values(groupIds.map((groupId) => ({ clubId: row!.clubId, seriesId: row!.id, groupId })));
  return row!;
}

export async function lockSeries(tx: Tx, id: string): Promise<SeriesRow | null> {
  const [row] = await tx
    .select()
    .from(activitySeries)
    .where(eq(activitySeries.id, id))
    .for("update");
  return row ?? null;
}

export async function findSeries(tx: Tx, id: string): Promise<SeriesRow | null> {
  const [row] = await tx.select().from(activitySeries).where(eq(activitySeries.id, id));
  return row ?? null;
}

export async function updateSeries(
  tx: Tx,
  id: string,
  values: Partial<typeof activitySeries.$inferInsert>,
): Promise<SeriesRow> {
  const [row] = await tx
    .update(activitySeries)
    .set(values)
    .where(eq(activitySeries.id, id))
    .returning();
  return row!;
}

export async function seriesGroupIds(tx: Tx, seriesId: string): Promise<string[]> {
  const rows = await tx
    .select({ groupId: activitySeriesGroups.groupId })
    .from(activitySeriesGroups)
    .where(eq(activitySeriesGroups.seriesId, seriesId));
  return rows.map((r) => r.groupId);
}

/** The series' sessions on or after a local date (all of them with `from` null). */
export async function seriesSessions(
  tx: Tx,
  seriesId: string,
  from: string | null,
): Promise<ActivityRow[]> {
  return tx
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.seriesId, seriesId),
        from ? sql`${activities.occurrenceOn} >= ${from}` : undefined,
      ),
    )
    .orderBy(asc(activities.startsAt));
}

export async function countSeriesSessions(tx: Tx, seriesId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.activities WHERE series_id = ${seriesId}`);
  return rows[0]?.n ?? 0;
}

/** Updates many sessions of a series at once (one statement). */
export async function updateSessions(
  tx: Tx,
  rows: readonly {
    id: string;
    startsAt: Date;
    endsAt: Date;
    kind: string;
    title: string;
    notes: string | null;
    leaderNotes: string | null;
    locationId: string | null;
    locationText: string | null;
    responseMode: string;
    respondBy: Date | null;
    bump: boolean;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    UPDATE public.activities a SET
      starts_at = v.starts_at, ends_at = v.ends_at, kind = v.kind, title = v.title,
      notes = v.notes, leader_notes = v.leader_notes, location_id = v.location_id,
      location_text = v.location_text, response_mode = v.response_mode, respond_by = v.respond_by,
      sequence = a.sequence + CASE WHEN v.bump THEN 1 ELSE 0 END,
      changed_at = CASE WHEN v.bump THEN now() ELSE a.changed_at END
    FROM jsonb_to_recordset(${JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        starts_at: r.startsAt.toISOString(),
        ends_at: r.endsAt.toISOString(),
        kind: r.kind,
        title: r.title,
        notes: r.notes,
        leader_notes: r.leaderNotes,
        location_id: r.locationId,
        location_text: r.locationText,
        response_mode: r.responseMode,
        respond_by: r.respondBy?.toISOString() ?? null,
        bump: r.bump,
      })),
    )}::jsonb) AS v(id uuid, starts_at timestamptz, ends_at timestamptz, kind text, title text,
      notes text, leader_notes text, location_id uuid, location_text text, response_mode text,
      respond_by timestamptz, bump boolean)
    WHERE a.id = v.id`);
}

export async function moveSessionsToSeries(
  tx: Tx,
  ids: readonly string[],
  seriesId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(activities)
    .set({ seriesId })
    .where(inArray(activities.id, [...ids]));
}

// --- My schedule ---------------------------------------------------------------------

export interface ScheduleRow {
  activityId: string;
  clubId: string;
  kind: string;
  title: string;
  status: string;
  cancelledReason: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  meetAt: Date | null;
  place: string | null;
  changedAt: Date;
  responseMode: string;
  respondBy: Date | null;
  groupIds: string[];
  personIds: string[];
  /** Those of personIds who are members (not leaders) of one of its groups: they answer. */
  memberIds: string[];
  /** Answers of the people in personIds, by person (P1.5). */
  answers: Record<string, string>;
}

/**
 * The activities of the groups these people are in (open group memberships),
 * across clubs, in (starts_at, activity) order. Row-level security lets the
 * actor read only their own and their wards' memberships and the entries of
 * those groups (ADR 0034); a joint activity comes once.
 */
export interface ScheduleInput {
  personIds: readonly string[];
  from: Date;
  to: Date;
  clubId: string | null;
  cursor: string | null;
  limit: number;
}

/** The schedule's statement: open group memberships, then each group's entries in the range. */
export function scheduleQuery(input: ScheduleInput): SQL {
  return sql`
    WITH mine AS (
      SELECT gm.person_id, gm.group_id, gm.function FROM public.group_memberships gm
      WHERE gm.person_id = ANY (${uuidArray(input.personIds)}::uuid[])
        AND gm.valid_to IS NULL
        ${input.clubId ? sql`AND gm.club_id = ${input.clubId}` : sql``}
    ), hits AS (
      SELECT se.*, m.person_id, m.function FROM mine m
      JOIN public.schedule_entries se ON se.group_id = m.group_id
      WHERE se.starts_at >= ${input.from} AND se.starts_at < ${input.to}
    )
    SELECT h.activity_id, h.club_id, h.kind, h.title, h.status, h.cancelled_reason, h.starts_at,
      h.ends_at, h.all_day, h.meet_at, h.place, h.changed_at, h.response_mode, h.respond_by,
      array_agg(DISTINCT h.group_id) AS group_ids, array_agg(DISTINCT h.person_id) AS person_ids,
      coalesce(array_agg(DISTINCT h.person_id) FILTER (WHERE h.function = 'member'), '{}') AS member_ids,
      (SELECT coalesce(jsonb_object_agg(r.person_id, r.status), '{}') FROM public.activity_responses r
       WHERE r.person_id = ANY (array_agg(DISTINCT h.person_id)) AND r.activity_id = h.activity_id) AS answers
    FROM hits h
    WHERE true ${
      input.cursor
        ? sql`AND (h.starts_at, h.activity_id) > (SELECT a.starts_at, a.activity_id FROM public.schedule_entries a WHERE a.activity_id = ${input.cursor} LIMIT 1)`
        : sql``
    }
    GROUP BY h.activity_id, h.club_id, h.kind, h.title, h.status, h.cancelled_reason,
      h.starts_at, h.ends_at, h.all_day, h.meet_at, h.place, h.changed_at, h.response_mode,
      h.respond_by
    ORDER BY h.starts_at, h.activity_id
    LIMIT ${input.limit}`;
}

export async function schedule(tx: Tx, input: ScheduleInput): Promise<ScheduleRow[]> {
  if (input.personIds.length === 0) return [];
  const { rows } = await tx.execute<{
    activity_id: string;
    club_id: string;
    kind: string;
    title: string;
    status: string;
    cancelled_reason: string | null;
    starts_at: string;
    ends_at: string;
    all_day: boolean;
    meet_at: string | null;
    place: string | null;
    changed_at: string;
    response_mode: string;
    respond_by: string | null;
    group_ids: string[];
    person_ids: string[];
    member_ids: string[];
    answers: Record<string, string>;
  }>(scheduleQuery(input));
  return rows.map((r) => ({
    activityId: r.activity_id,
    clubId: r.club_id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    cancelledReason: r.cancelled_reason,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    allDay: r.all_day,
    meetAt: r.meet_at ? new Date(r.meet_at) : null,
    place: r.place,
    changedAt: new Date(r.changed_at),
    responseMode: r.response_mode,
    respondBy: r.respond_by ? new Date(r.respond_by) : null,
    groupIds: r.group_ids,
    personIds: r.person_ids,
    memberIds: r.member_ids,
    answers: r.answers,
  }));
}

/** Group names readable by the actor (own and wards' groups, ADR 0023). */
export async function groupNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(inArray(groups.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}
