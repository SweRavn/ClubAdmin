// SPDX-License-Identifier: AGPL-3.0-only
// Queries on locations, activity series, activities, their groups and the
// calendars' read model (schedule_entries, ADR 0034). IDs only towards
// people: no query here reads names.

import { and, asc, eq, inArray, isNull, schema, type SQL, sql, type Tx } from "@clubadmin/db";
import type { RequestLead } from "@clubadmin/shared";

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

/**
 * How many rows use each of these places (P2.7c): activities, series,
 * events, duty shifts and the club's car pool start. One statement for a
 * page of places, each part by the club and the place.
 */
export async function locationUsage(
  tx: Tx,
  clubId: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await tx.execute<{ id: string; n: number }>(sql`
    SELECT location_id AS id, count(*)::int AS n FROM (
      SELECT location_id FROM public.activities
        WHERE club_id = ${clubId} AND location_id IN (${list})
      UNION ALL SELECT location_id FROM public.activity_series
        WHERE club_id = ${clubId} AND location_id IN (${list})
      UNION ALL SELECT location_id FROM public.events
        WHERE club_id = ${clubId} AND location_id IN (${list})
      UNION ALL SELECT location_id FROM public.tasks
        WHERE club_id = ${clubId} AND location_id IN (${list})
      UNION ALL SELECT carpool_start_location_id FROM public.clubs
        WHERE id = ${clubId} AND carpool_start_location_id IN (${list})
    ) used GROUP BY location_id
  `);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export async function deleteLocation(tx: Tx, id: string): Promise<void> {
  await tx.delete(locations).where(eq(locations.id, id));
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

export async function findActivities(tx: Tx, ids: readonly string[]): Promise<ActivityRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(activities)
    .where(inArray(activities.id, [...ids]));
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
    INSERT INTO public.schedule_entries (club_id, activity_id, group_id, kind, kind_label, title,
      status, cancelled_reason, starts_at, ends_at, all_day, meet_at, place, changed_at,
      response_mode, respond_by, invitees_only, sequence, meet_place, address, latitude, longitude)
    SELECT a.club_id, a.id, ag.group_id, a.kind, a.kind_label, a.title, a.status, a.cancelled_reason,
      a.starts_at, a.ends_at, a.all_day, a.meet_at, coalesce(l.name, a.location_text), a.changed_at,
      a.response_mode, a.respond_by, a.invitees_only, a.sequence, a.meet_place,
      nullif(concat_ws(', ', l.street, nullif(concat_ws(' ', l.postal_code, l.city), '')), ''),
      l.latitude, l.longitude
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
    requestLead: RequestLead | null;
    requestAt: Date | null;
    transportMode: string | null;
    bump: boolean;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    UPDATE public.activities a SET
      starts_at = v.starts_at, ends_at = v.ends_at, kind = v.kind, title = v.title,
      notes = v.notes, leader_notes = v.leader_notes, location_id = v.location_id,
      location_text = v.location_text, response_mode = v.response_mode, respond_by = v.respond_by,
      request_lead = v.request_lead, request_at = v.request_at, transport_mode = v.transport_mode,
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
        request_lead: r.requestLead,
        request_at: r.requestAt?.toISOString() ?? null,
        transport_mode: r.transportMode,
        bump: r.bump,
      })),
    )}::jsonb) AS v(id uuid, starts_at timestamptz, ends_at timestamptz, kind text, title text,
      notes text, leader_notes text, location_id uuid, location_text text, response_mode text,
      respond_by timestamptz, request_lead jsonb, request_at timestamptz, transport_mode text,
      bump boolean)
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
  kindLabel: string | null;
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
  /** The event the activity belongs to (P1.6), if any. */
  eventId: string | null;
  /** For calendar feeds (P1.11). */
  sequence: number;
  meetPlace: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Only those called up take part (feeds of a group say so). */
  inviteesOnly: boolean;
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
  /** Only this activity (an answer link, P1.11). */
  activityId?: string | null;
}

/** The schedule's statement: open group memberships, then each group's entries in the range. */
export function scheduleQuery(input: ScheduleInput): SQL {
  return sql`
    WITH mine AS (
      SELECT gm.person_id, gm.group_id, gm.participates FROM public.group_memberships gm
      WHERE gm.person_id = ANY (${uuidArray(input.personIds)}::uuid[])
        AND gm.valid_to IS NULL
        ${input.clubId ? sql`AND gm.club_id = ${input.clubId}` : sql``}
    ), hits AS (
      SELECT se.*, m.person_id, m.participates FROM mine m
      JOIN public.schedule_entries se ON se.group_id = m.group_id
      WHERE se.starts_at >= ${input.from} AND se.starts_at < ${input.to}
        ${input.activityId ? sql`AND se.activity_id = ${input.activityId}` : sql``}
        -- A call-up (#19): participants who are not called up do not have it in their schedule.
        AND (NOT m.participates OR NOT se.invitees_only OR EXISTS (
          SELECT 1 FROM public.activity_invitees i
          WHERE i.activity_id = se.activity_id AND i.person_id = m.person_id))
      UNION ALL
      -- P2.10: called up from another group (taking part), or the call-up taken
      -- back (shown with its reason until the session has ended).
      SELECT se.*, x.person_id, x.participates FROM (
        SELECT i.activity_id, i.person_id, true AS participates FROM public.activity_invitees i
        WHERE i.person_id = ANY (${uuidArray(input.personIds)}::uuid[])
          ${input.clubId ? sql`AND i.club_id = ${input.clubId}` : sql``}
        UNION
        SELECT v.activity_id, v.person_id, false FROM public.activity_callup_revocations v
        WHERE v.person_id = ANY (${uuidArray(input.personIds)}::uuid[])
          ${input.clubId ? sql`AND v.club_id = ${input.clubId}` : sql``}
      ) x
      JOIN LATERAL (
        SELECT s2.* FROM public.schedule_entries s2 WHERE s2.activity_id = x.activity_id
        ORDER BY s2.group_id LIMIT 1) se ON true
      WHERE se.starts_at >= ${input.from} AND se.starts_at < ${input.to}
        AND (x.participates OR se.ends_at > now())
        ${input.activityId ? sql`AND se.activity_id = ${input.activityId}` : sql``}
    )
    SELECT h.activity_id, h.club_id, h.kind, h.kind_label, h.title, h.status, h.cancelled_reason,
      h.starts_at, h.ends_at, h.all_day, h.meet_at, h.place, h.changed_at, h.response_mode,
      h.respond_by, h.sequence, h.meet_place, h.address, h.latitude, h.longitude,
      array_agg(DISTINCT h.group_id) AS group_ids, array_agg(DISTINCT h.person_id) AS person_ids,
      coalesce(array_agg(DISTINCT h.person_id) FILTER (WHERE h.participates), '{}') AS member_ids,
      (SELECT coalesce(jsonb_object_agg(r.person_id, r.status), '{}') FROM public.activity_responses r
       WHERE r.person_id = ANY (array_agg(DISTINCT h.person_id)) AND r.activity_id = h.activity_id) AS answers,
      -- The event link (P1.6): read-only, the events module owns event_activities.
      (SELECT ea.event_id FROM public.event_activities ea WHERE ea.activity_id = h.activity_id) AS event_id
    FROM hits h
    WHERE true ${
      input.cursor
        ? sql`AND (h.starts_at, h.activity_id) > (SELECT a.starts_at, a.activity_id FROM public.schedule_entries a WHERE a.activity_id = ${input.cursor} LIMIT 1)`
        : sql``
    }
    GROUP BY h.activity_id, h.club_id, h.kind, h.kind_label, h.title, h.status, h.cancelled_reason,
      h.starts_at, h.ends_at, h.all_day, h.meet_at, h.place, h.changed_at, h.response_mode,
      h.respond_by, h.sequence, h.meet_place, h.address, h.latitude, h.longitude
    ORDER BY h.starts_at, h.activity_id
    LIMIT ${input.limit}`;
}

type ScheduleDbRow = {
  activity_id: string;
  club_id: string;
  kind: string;
  kind_label: string | null;
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
  event_id: string | null;
  sequence: number;
  meet_place: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  invitees_only?: boolean;
};

const toScheduleRow = (r: ScheduleDbRow): ScheduleRow => ({
  activityId: r.activity_id,
  clubId: r.club_id,
  kind: r.kind,
  kindLabel: r.kind_label,
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
  eventId: r.event_id,
  sequence: r.sequence,
  meetPlace: r.meet_place,
  address: r.address,
  latitude: r.latitude,
  longitude: r.longitude,
  inviteesOnly: r.invitees_only === true,
});

/**
 * A group's or a club's calendar for a feed (P1.11): one row per activity in
 * the range, from the read model only (schedule_entries_group_idx or
 * schedule_entries_club_idx), without people or answers.
 */
export async function feedEntries(
  tx: Tx,
  target: { groupId: string } | { clubId: string },
  range: { from: Date; to: Date; limit: number },
): Promise<ScheduleRow[]> {
  const where =
    "groupId" in target ? sql`se.group_id = ${target.groupId}` : sql`se.club_id = ${target.clubId}`;
  const { rows } = await tx.execute<ScheduleDbRow>(sql`
    SELECT se.activity_id, se.club_id, se.kind, se.kind_label, se.title, se.status,
      se.cancelled_reason, se.starts_at, se.ends_at, se.all_day, se.meet_at, se.place,
      se.changed_at, se.response_mode, se.respond_by, se.sequence, se.meet_place, se.address,
      se.latitude, se.longitude, array_agg(se.group_id) AS group_ids,
      '{}'::uuid[] AS person_ids, '{}'::uuid[] AS member_ids, '{}'::jsonb AS answers,
      NULL::uuid AS event_id, bool_or(se.invitees_only) AS invitees_only
    FROM public.schedule_entries se
    WHERE ${where} AND se.starts_at >= ${range.from} AND se.starts_at < ${range.to}
    GROUP BY se.activity_id, se.club_id, se.kind, se.kind_label, se.title, se.status,
      se.cancelled_reason, se.starts_at, se.ends_at, se.all_day, se.meet_at, se.place,
      se.changed_at, se.response_mode, se.respond_by, se.sequence, se.meet_place, se.address,
      se.latitude, se.longitude
    ORDER BY se.starts_at, se.activity_id
    LIMIT ${range.limit}`);
  return rows.map(toScheduleRow);
}

export async function schedule(tx: Tx, input: ScheduleInput): Promise<ScheduleRow[]> {
  if (input.personIds.length === 0) return [];
  const { rows } = await tx.execute<ScheduleDbRow>(scheduleQuery(input));
  return rows.map(toScheduleRow);
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

/** Series behind the horizon (P1.14): open-ended or ending later than they are materialised. */
export async function seriesToExtend(
  tx: Tx,
  until: string,
  limit: number,
): Promise<{ id: string; clubId: string }[]> {
  const { rows } = await tx.execute<{ id: string; club_id: string }>(sql`
    SELECT id, club_id FROM public.activity_series
    WHERE (ends_on IS NULL OR ends_on > materialized_until) AND materialized_until < ${until}::date
    ORDER BY materialized_until, id
    LIMIT ${limit}`);
  return rows.map((r) => ({ id: r.id, clubId: r.club_id }));
}

// --- Programmes (P2.9) -------------------------------------------------------------

/** Each activity in its own groups (one statement for a whole programme). */
export async function insertActivityGroupPairs(
  tx: Tx,
  clubId: string,
  pairs: readonly { activityId: string; groupId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.insert(activityGroups).values(pairs.map((p) => ({ clubId, ...p })));
}

/** Scheduled activities at these places overlapping the range (the location index). */
export async function activitiesAtLocations(
  tx: Tx,
  clubId: string,
  locationIds: readonly string[],
  range: { from: Date; to: Date },
): Promise<{ id: string; locationId: string; startsAt: Date; endsAt: Date }[]> {
  if (locationIds.length === 0) return [];
  const { rows } = await tx.execute<{
    id: string;
    location_id: string;
    starts_at: string;
    ends_at: string;
  }>(sql`
    SELECT id, location_id, starts_at, ends_at FROM public.activities
    WHERE club_id = ${clubId} AND location_id = ANY (${uuidArray(locationIds)}::uuid[])
      AND starts_at < ${range.to.toISOString()}::timestamptz
      AND starts_at >= ${new Date(range.from.getTime() - 86_400_000).toISOString()}::timestamptz
      AND ends_at > ${range.from.toISOString()}::timestamptz AND status = 'scheduled'
    ORDER BY starts_at LIMIT 2000`);
  return rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
  }));
}

/** A programme's activities, by start (optionally of a range), from (programme_id, starts_at). */
export function programmeActivities(
  tx: Tx,
  programmeId: string,
  range: { from: Date; to: Date } | null = null,
): Promise<ActivityRow[]> {
  const where = range
    ? and(
        eq(activities.programmeId, programmeId),
        sql`${activities.startsAt} >= ${range.from.toISOString()}::timestamptz`,
        sql`${activities.startsAt} < ${range.to.toISOString()}::timestamptz`,
      )
    : eq(activities.programmeId, programmeId);
  return tx
    .select()
    .from(activities)
    .where(where)
    .orderBy(asc(activities.startsAt), asc(activities.id))
    .limit(1000);
}

/** A group's activities starting in a range (the read model's group index). */
export async function groupActivitiesInRange(
  tx: Tx,
  groupId: string,
  range: { from: Date; to: Date },
): Promise<ActivityRow[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT se.activity_id AS id FROM public.schedule_entries se
    WHERE se.group_id = ${groupId}
      AND se.starts_at >= ${range.from.toISOString()}::timestamptz
      AND se.starts_at < ${range.to.toISOString()}::timestamptz
    ORDER BY se.starts_at, se.activity_id LIMIT 400`);
  return orderedActivities(
    tx,
    rows.map((r) => r.id),
  );
}

/** Puts activities that belong to no programme in this one. */
export async function setProgramme(
  tx: Tx,
  programmeId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    UPDATE public.activities SET programme_id = ${programmeId}::uuid
    WHERE id = ANY (${uuidArray(ids)}::uuid[]) AND programme_id IS NULL`);
}

// --- A series' call-up (P2.10) ---------------------------------------------------------

/** A series' coming sessions (not started), by start: the grid's page, or all for a change. */
export async function seriesComingSessions(
  tx: Tx,
  seriesId: string,
  after: Date,
  page: { cursor: string | null; limit: number } | null,
): Promise<ActivityRow[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT a.id FROM public.activities a
    WHERE a.series_id = ${seriesId} AND a.starts_at > ${after.toISOString()}::timestamptz
      ${
        page?.cursor
          ? sql`AND (a.starts_at, a.id) > (SELECT c.starts_at, c.id FROM public.activities c WHERE c.id = ${page.cursor}::uuid)`
          : sql``
      }
    ORDER BY a.starts_at, a.id
    LIMIT ${page ? page.limit : 1000}`);
  return orderedActivities(
    tx,
    rows.map((r) => r.id),
  );
}

/** Those who take part in a series' groups now, and its groups' leaders-only people. */
export async function seriesGroupPeople(
  tx: Tx,
  seriesId: string,
): Promise<{ participants: Set<string>; leaders: Set<string>; guests: Set<string> }> {
  const { rows } = await tx.execute<{ person_id: string; part: boolean; member: boolean }>(sql`
    SELECT gm.person_id, bool_or(gm.participates) AS part,
      bool_or(gm.participates AND NOT coalesce(ro.guest, false)) AS member
    FROM public.activity_series_groups sg
    JOIN public.group_memberships gm ON gm.club_id = sg.club_id AND gm.group_id = sg.group_id
      AND gm.valid_to IS NULL
    LEFT JOIN public.roles ro ON ro.id = gm.role_id
    WHERE sg.series_id = ${seriesId}
    GROUP BY gm.person_id`);
  return {
    participants: new Set(rows.filter((r) => r.part).map((r) => r.person_id)),
    leaders: new Set(rows.filter((r) => !r.part).map((r) => r.person_id)),
    guests: new Set(rows.filter((r) => r.part && !r.member).map((r) => r.person_id)),
  };
}

/** The club groups people take part in (a hint for guests). */
export async function groupsOfPeople(
  tx: Tx,
  clubId: string,
  personIds: readonly string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (personIds.length === 0) return map;
  const { rows } = await tx.execute<{ person_id: string; id: string; name: string }>(sql`
    SELECT DISTINCT gm.person_id, g.id, g.name FROM public.group_memberships gm
    JOIN public.groups g ON g.id = gm.group_id
    WHERE gm.club_id = ${clubId} AND gm.valid_to IS NULL AND gm.participates
      AND g.archived_at IS NULL AND gm.person_id = ANY (${uuidArray(personIds)}::uuid[])
    ORDER BY g.name`);
  for (const r of rows)
    map.set(r.person_id, [...(map.get(r.person_id) ?? []), { id: r.id, name: r.name }]);
  return map;
}

/** Copies a series' call-up to its successor (a split, P2.10). */
export async function copySeriesCallUp(tx: Tx, fromId: string, toId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.activity_series t SET invitees_only = f.invitees_only
    FROM public.activity_series f WHERE f.id = ${fromId}::uuid AND t.id = ${toId}::uuid`);
  await tx.execute(sql`
    INSERT INTO public.activity_series_invitees (club_id, series_id, person_id, added_by_person_id)
    SELECT club_id, ${toId}::uuid, person_id, added_by_person_id
    FROM public.activity_series_invitees WHERE series_id = ${fromId}::uuid
    ON CONFLICT (series_id, person_id) DO NOTHING`);
}

/** New sessions of a series with a call-up get its list (one statement). */
export async function callUpNewSessions(
  tx: Tx,
  clubId: string,
  seriesId: string,
  activityIds: readonly string[],
): Promise<void> {
  if (activityIds.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.activity_invitees (club_id, activity_id, person_id, invited_by_person_id)
    SELECT ${clubId}::uuid, a, si.person_id, coalesce(si.added_by_person_id, s.created_by_person_id, si.person_id)
    FROM unnest(${uuidArray(activityIds)}::uuid[]) AS a
    CROSS JOIN public.activity_series_invitees si
    JOIN public.activity_series s ON s.id = si.series_id
    WHERE si.series_id = ${seriesId} AND s.invitees_only
    ON CONFLICT (activity_id, person_id) DO NOTHING`);
}
