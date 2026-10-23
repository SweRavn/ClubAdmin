// SPDX-License-Identifier: AGPL-3.0-only
// Queries on responses and attendance (P1.5, ADR 0035). The roster of an
// activity is who was in its groups on its start (group_memberships valid at
// starts_at, as "My schedule" reads the open ones): members are
// participants, the other functions leaders. IDs only towards people.

import { type SQL, sql, type Tx } from "@clubadmin/db";
import type {
  AttendanceRole,
  AttendanceStatus,
  ResponseMode,
  ResponseStatus,
} from "@clubadmin/shared";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

export interface ResponseRow {
  id: string;
  personId: string;
  status: ResponseStatus;
  note: string | null;
  respondedByPersonId: string;
  respondedAt: Date;
}

export interface MarkRow {
  id: string;
  personId: string;
  status: AttendanceStatus;
  role: AttendanceRole;
  guest: boolean;
  recordedByPersonId: string;
  recordedAt: Date;
  correctedReason: string | null;
}

export interface RosterRow {
  personId: string;
  role: AttendanceRole;
}

export interface ResponseCountRow {
  activityId: string;
  roster: number;
  attending: number;
  notAttending: number;
}

/** The activity's roster: participants (members) and leaders of its groups on its start. */
export function rosterQuery(activityIds: readonly string[]): SQL {
  return sql`
    SELECT ag.activity_id, gm.person_id,
      CASE WHEN bool_or(gm.function = 'member') THEN 'participant' ELSE 'leader' END AS role
    FROM public.activities a
    JOIN public.activity_groups ag ON ag.activity_id = a.id
    JOIN public.group_memberships gm ON gm.club_id = ag.club_id AND gm.group_id = ag.group_id
      AND gm.valid_from <= a.starts_at AND (gm.valid_to IS NULL OR gm.valid_to > a.starts_at)
    WHERE a.id = ANY (${uuidArray(activityIds)}::uuid[])
    GROUP BY ag.activity_id, gm.person_id`;
}

export async function roster(tx: Tx, activityId: string): Promise<RosterRow[]> {
  const { rows } = await tx.execute<{ person_id: string; role: AttendanceRole }>(
    rosterQuery([activityId]),
  );
  return rows.map((r) => ({ personId: r.person_id, role: r.role }));
}

/** Whether each person was a participant of the activity's groups on its start. */
export async function onRoster(
  tx: Tx,
  activityId: string,
  personIds: readonly string[],
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT r.person_id FROM (${rosterQuery([activityId])}) r
    WHERE r.role = 'participant' AND r.person_id = ANY (${uuidArray(personIds)}::uuid[])`);
  return new Set(rows.map((r) => r.person_id));
}

// --- Responses --------------------------------------------------------------------

const RESPONSE_COLUMNS = sql`id, person_id, status, note, responded_by_person_id, responded_at`;

function toResponse(r: {
  id: string;
  person_id: string;
  status: ResponseStatus;
  note: string | null;
  responded_by_person_id: string;
  responded_at: string | Date;
}): ResponseRow {
  return {
    id: r.id,
    personId: r.person_id,
    status: r.status,
    note: r.note,
    respondedByPersonId: r.responded_by_person_id,
    respondedAt: new Date(r.responded_at),
  };
}

export async function responses(
  tx: Tx,
  activityId: string,
  personIds?: readonly string[],
): Promise<ResponseRow[]> {
  const { rows } = await tx.execute<Parameters<typeof toResponse>[0]>(sql`
    SELECT ${RESPONSE_COLUMNS} FROM public.activity_responses
    WHERE activity_id = ${activityId}
      ${personIds ? sql`AND person_id = ANY (${uuidArray(personIds)}::uuid[])` : sql``}`);
  return rows.map(toResponse);
}

export async function upsertResponse(
  tx: Tx,
  values: {
    clubId: string;
    activityId: string;
    personId: string;
    status: ResponseStatus;
    note: string | null;
    respondedByPersonId: string;
  },
): Promise<ResponseRow> {
  const { rows } = await tx.execute<Parameters<typeof toResponse>[0]>(sql`
    INSERT INTO public.activity_responses (club_id, activity_id, person_id, status, note,
      responded_by_person_id, responded_at)
    VALUES (${values.clubId}, ${values.activityId}, ${values.personId}, ${values.status},
      ${values.note}, ${values.respondedByPersonId}, now())
    ON CONFLICT (activity_id, person_id) DO UPDATE SET status = EXCLUDED.status,
      note = EXCLUDED.note, responded_by_person_id = EXCLUDED.responded_by_person_id,
      responded_at = EXCLUDED.responded_at
    RETURNING ${RESPONSE_COLUMNS}`);
  return toResponse(rows[0]!);
}

export async function deleteResponse(
  tx: Tx,
  activityId: string,
  personId: string,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    DELETE FROM public.activity_responses WHERE activity_id = ${activityId} AND person_id = ${personId}
    RETURNING id`);
  return rows.length > 0;
}

/**
 * Counts per activity among its roster's participants: one grouped statement
 * for a page of a calendar (never one per activity).
 */
export async function responseCounts(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, ResponseCountRow>> {
  if (activityIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    activity_id: string;
    roster: number;
    attending: number;
    not_attending: number;
  }>(sql`
    SELECT r.activity_id, count(*)::int AS roster,
      count(*) FILTER (WHERE ar.status = 'attending')::int AS attending,
      count(*) FILTER (WHERE ar.status = 'not_attending')::int AS not_attending
    FROM (${rosterQuery(activityIds)}) r
    LEFT JOIN public.activity_responses ar ON ar.activity_id = r.activity_id AND ar.person_id = r.person_id
    WHERE r.role = 'participant'
    GROUP BY r.activity_id`);
  return new Map(
    rows.map((r) => [
      r.activity_id,
      {
        activityId: r.activity_id,
        roster: r.roster,
        attending: r.attending,
        notAttending: r.not_attending,
      },
    ]),
  );
}

/** The leaders' list: the roster's participants with their answers, keyset by person. */
export async function responseList(
  tx: Tx,
  activityId: string,
  page: { status: ResponseStatus | "none" | null; cursor: string | null; limit: number },
): Promise<(RosterRow & { response: ResponseRow | null })[]> {
  const { rows } = await tx.execute<{
    id: string | null;
    person_id: string;
    status: ResponseStatus | null;
    note: string | null;
    responded_by_person_id: string | null;
    responded_at: string | null;
  }>(sql`
    SELECT ar.id, r.person_id, ar.status, ar.note, ar.responded_by_person_id, ar.responded_at
    FROM (${rosterQuery([activityId])}) r
    LEFT JOIN public.activity_responses ar ON ar.activity_id = r.activity_id AND ar.person_id = r.person_id
    WHERE r.role = 'participant'
      ${page.status === "none" ? sql`AND ar.id IS NULL` : page.status ? sql`AND ar.status = ${page.status}` : sql``}
      ${page.cursor ? sql`AND r.person_id > ${page.cursor}` : sql``}
    ORDER BY r.person_id
    LIMIT ${page.limit}`);
  return rows.map((r) => ({
    personId: r.person_id,
    role: "participant" as const,
    response:
      r.id && r.status && r.responded_by_person_id && r.responded_at
        ? toResponse({
            id: r.id,
            person_id: r.person_id,
            status: r.status,
            note: r.note,
            responded_by_person_id: r.responded_by_person_id,
            responded_at: r.responded_at,
          })
        : null,
  }));
}

/** Activities among these that have answers or attendance (they are cancelled, never deleted). */
export async function withRecords(tx: Tx, activityIds: readonly string[]): Promise<Set<string>> {
  if (activityIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT a.id FROM unnest(${uuidArray(activityIds)}::uuid[]) a(id)
    WHERE EXISTS (SELECT 1 FROM public.activity_responses r WHERE r.activity_id = a.id)
       OR EXISTS (SELECT 1 FROM public.attendance_records m WHERE m.activity_id = a.id)`);
  return new Set(rows.map((r) => r.id));
}

/** The answers of these people to these activities (My schedule; row-level security: mine and my wards'). */
export async function answersOf(
  tx: Tx,
  activityIds: readonly string[],
  personIds: readonly string[],
): Promise<Map<string, Map<string, ResponseStatus>>> {
  const map = new Map<string, Map<string, ResponseStatus>>();
  if (activityIds.length === 0 || personIds.length === 0) return map;
  const { rows } = await tx.execute<{
    activity_id: string;
    person_id: string;
    status: ResponseStatus;
  }>(sql`
    SELECT activity_id, person_id, status FROM public.activity_responses
    WHERE person_id = ANY (${uuidArray(personIds)}::uuid[])
      AND activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
  for (const r of rows) {
    const byPerson = map.get(r.activity_id) ?? new Map<string, ResponseStatus>();
    byPerson.set(r.person_id, r.status);
    map.set(r.activity_id, byPerson);
  }
  return map;
}

// --- Attendance -------------------------------------------------------------------

const MARK_COLUMNS = sql`id, person_id, status, role, guest, recorded_by_person_id, recorded_at, corrected_reason`;

function toMark(r: {
  id: string;
  person_id: string;
  status: AttendanceStatus;
  role: AttendanceRole;
  guest: boolean;
  recorded_by_person_id: string;
  recorded_at: string | Date;
  corrected_reason: string | null;
}): MarkRow {
  return {
    id: r.id,
    personId: r.person_id,
    status: r.status,
    role: r.role,
    guest: r.guest,
    recordedByPersonId: r.recorded_by_person_id,
    recordedAt: new Date(r.recorded_at),
    correctedReason: r.corrected_reason,
  };
}

export async function marks(tx: Tx, activityId: string): Promise<MarkRow[]> {
  const { rows } = await tx.execute<Parameters<typeof toMark>[0]>(sql`
    SELECT ${MARK_COLUMNS} FROM public.attendance_records WHERE activity_id = ${activityId}`);
  return rows.map(toMark);
}

/** Inserts or replaces marks in one statement. */
export async function upsertMarks(
  tx: Tx,
  clubId: string,
  activityId: string,
  rows: readonly {
    personId: string;
    status: AttendanceStatus;
    role: AttendanceRole;
    guest: boolean;
    recordedByPersonId: string;
    recordedAt: Date;
    correctedReason: string | null;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.attendance_records (club_id, activity_id, person_id, status, role, guest,
      recorded_by_person_id, recorded_at, corrected_reason)
    SELECT ${clubId}, ${activityId}, v.person_id, v.status, v.role, v.guest,
      v.recorded_by_person_id, v.recorded_at, v.corrected_reason
    FROM jsonb_to_recordset(${JSON.stringify(
      rows.map((r) => ({
        person_id: r.personId,
        status: r.status,
        role: r.role,
        guest: r.guest,
        recorded_by_person_id: r.recordedByPersonId,
        recorded_at: r.recordedAt.toISOString(),
        corrected_reason: r.correctedReason,
      })),
    )}::jsonb) AS v(person_id uuid, status text, role text, guest boolean,
      recorded_by_person_id uuid, recorded_at timestamptz, corrected_reason text)
    ON CONFLICT (activity_id, person_id) DO UPDATE SET status = EXCLUDED.status,
      role = EXCLUDED.role, guest = EXCLUDED.guest,
      recorded_by_person_id = EXCLUDED.recorded_by_person_id,
      recorded_at = EXCLUDED.recorded_at, corrected_reason = EXCLUDED.corrected_reason`);
}

// --- Group summaries --------------------------------------------------------------

export interface SessionRow {
  activityId: string;
  title: string;
  kind: string;
  startsAt: Date;
  endsAt: Date;
  responseMode: ResponseMode;
}

/** The group's sessions held in a range (not cancelled, started), from the calendar's index. */
export function groupSessionsQuery(groupId: string, range: { from: Date; to: Date }): SQL {
  return sql`
    SELECT se.activity_id, se.title, se.kind, se.starts_at, se.ends_at, se.response_mode
    FROM public.schedule_entries se
    WHERE se.group_id = ${groupId} AND se.starts_at >= ${range.from}
      AND se.starts_at < least(${range.to}::timestamptz, now()) AND se.status = 'scheduled'
    ORDER BY se.starts_at, se.activity_id`;
}

export async function groupSessions(
  tx: Tx,
  groupId: string,
  range: { from: Date; to: Date },
): Promise<SessionRow[]> {
  const { rows } = await tx.execute<{
    activity_id: string;
    title: string;
    kind: string;
    starts_at: string;
    ends_at: string;
    response_mode: ResponseMode;
  }>(groupSessionsQuery(groupId, range));
  return rows.map((r) => ({
    activityId: r.activity_id,
    title: r.title,
    kind: r.kind,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    responseMode: r.response_mode,
  }));
}

/** Who was marked present in these sessions (for the counts and the grant rules). */
export async function presentIn(
  tx: Tx,
  clubId: string,
  activityIds: readonly string[],
): Promise<{ activityId: string; personId: string; role: AttendanceRole }[]> {
  if (activityIds.length === 0) return [];
  const { rows } = await tx.execute<{
    activity_id: string;
    person_id: string;
    role: AttendanceRole;
  }>(sql`
    SELECT activity_id, person_id, role FROM public.attendance_records
    WHERE club_id = ${clubId} AND activity_id = ANY (${uuidArray(activityIds)}::uuid[])
      AND status = 'present'`);
  return rows.map((r) => ({ activityId: r.activity_id, personId: r.person_id, role: r.role }));
}

/** Sessions among these with any mark. */
export async function recordedSessions(
  tx: Tx,
  clubId: string,
  activityIds: readonly string[],
): Promise<Set<string>> {
  if (activityIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ activity_id: string }>(sql`
    SELECT DISTINCT activity_id FROM public.attendance_records
    WHERE club_id = ${clubId} AND activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
  return new Set(rows.map((r) => r.activity_id));
}

export interface MemberSummaryRow {
  personId: string;
  sessions: number;
  present: number;
  absent: number;
  excused: number;
}

/**
 * Per member of the group during the range (keyset by person): the held
 * sessions while they were a member and their marks in them. One statement.
 */
export function memberSummaryQuery(
  clubId: string,
  groupId: string,
  range: { from: Date; to: Date },
  page: { cursor: string | null; limit: number },
): SQL {
  return sql`
    WITH s AS (${groupSessionsQuery(groupId, range)}),
    m AS (
      SELECT gm.person_id, array_agg(tstzrange(gm.valid_from, gm.valid_to)) AS periods
      FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.group_id = ${groupId} AND gm.function = 'member'
        AND gm.valid_from < ${range.to} AND (gm.valid_to IS NULL OR gm.valid_to > ${range.from})
        ${page.cursor ? sql`AND gm.person_id > ${page.cursor}` : sql``}
      GROUP BY gm.person_id
      ORDER BY gm.person_id
      LIMIT ${page.limit}
    )
    SELECT m.person_id,
      (SELECT count(*)::int FROM s WHERE EXISTS (
        SELECT 1 FROM unnest(m.periods) p WHERE p @> s.starts_at)) AS sessions,
      count(ar.id) FILTER (WHERE ar.status = 'present')::int AS present,
      count(ar.id) FILTER (WHERE ar.status = 'absent')::int AS absent,
      count(ar.id) FILTER (WHERE ar.status = 'excused')::int AS excused
    FROM m
    LEFT JOIN public.attendance_records ar ON ar.club_id = ${clubId} AND ar.person_id = m.person_id
      AND ar.activity_id IN (SELECT s.activity_id FROM s)
    GROUP BY m.person_id, m.periods
    ORDER BY m.person_id`;
}

export async function memberSummary(
  tx: Tx,
  clubId: string,
  groupId: string,
  range: { from: Date; to: Date },
  page: { cursor: string | null; limit: number },
): Promise<MemberSummaryRow[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    sessions: number;
    present: number;
    absent: number;
    excused: number;
  }>(memberSummaryQuery(clubId, groupId, range, page));
  return rows.map((r) => ({
    personId: r.person_id,
    sessions: r.sessions,
    present: r.present,
    absent: r.absent,
    excused: r.excused,
  }));
}
