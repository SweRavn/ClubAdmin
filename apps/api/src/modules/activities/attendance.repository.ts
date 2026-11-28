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

import { givenNameSortKey } from "../people/index.ts";

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
  /**
   * A guest (P2.10): a participant only through a guest role of the group,
   * or called up from another group (ad hoc).
   */
  guest: boolean;
}

export interface ResponseCountRow {
  activityId: string;
  roster: number;
  attending: number;
  notAttending: number;
}

/** The activity's roster: participants (members) and leaders of its groups on its start. */
export function rosterQuery(
  activityIds: readonly string[],
  options: { wholeGroups?: boolean } = {},
): SQL {
  // With a call-up (invitees_only, #19) only the people called up are
  // participants; the leaders stay. wholeGroups: everyone who could be called
  // up from the groups, and those called up from elsewhere.
  const calledUp = options.wholeGroups
    ? sql``
    : sql`AND (NOT gm.participates OR NOT a.invitees_only OR EXISTS (
        SELECT 1 FROM public.activity_invitees i
        WHERE i.club_id = a.club_id AND i.activity_id = a.id AND i.person_id = gm.person_id))`;
  // P2.10: called up from another group (ad hoc guests) are participants of
  // the activity only; a guest role of the group takes part without being a
  // member (permanent guests). `guest`: no ordinary participation.
  return sql`
    SELECT m.activity_id, m.person_id,
      CASE WHEN bool_or(m.part) THEN 'participant' ELSE 'leader' END AS role,
      (bool_or(m.part) AND NOT bool_or(m.member)) AS guest
    FROM (
      SELECT ag.activity_id, gm.person_id, gm.participates AS part,
        gm.participates AND NOT gm.guest AS member
      FROM public.activities a
      JOIN public.activity_groups ag ON ag.activity_id = a.id
      JOIN public.group_memberships gm ON gm.club_id = ag.club_id AND gm.group_id = ag.group_id
        AND gm.valid_from <= a.starts_at AND (gm.valid_to IS NULL OR gm.valid_to > a.starts_at)
      WHERE a.id = ANY (${uuidArray(activityIds)}::uuid[]) ${calledUp}
      UNION ALL
      SELECT i.activity_id, i.person_id, true, false
      FROM public.activities a
      JOIN public.activity_invitees i ON i.club_id = a.club_id AND i.activity_id = a.id
      WHERE a.id = ANY (${uuidArray(activityIds)}::uuid[]) AND a.invitees_only
    ) m
    GROUP BY m.activity_id, m.person_id`;
}

export async function roster(
  tx: Tx,
  activityId: string,
  options: { wholeGroups?: boolean } = {},
): Promise<RosterRow[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    role: AttendanceRole;
    guest: boolean;
  }>(sql`
    SELECT r.person_id, r.role, r.guest FROM (${rosterQuery([activityId], options)}) r
    ORDER BY ${givenNameSortKey(sql`r.person_id`)}, r.person_id`);
  return rows.map((r) => ({ personId: r.person_id, role: r.role, guest: r.guest }));
}

/** Whether each person is on the activity's roster, in any role (leaders answer too, P2.7b). */
export async function onRoster(
  tx: Tx,
  activityId: string,
  personIds: readonly string[],
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT r.person_id FROM (${rosterQuery([activityId])}) r
    WHERE r.person_id = ANY (${uuidArray(personIds)}::uuid[])`);
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

// --- Call-ups (#19) ---------------------------------------------------------------

/** Who is called up to an activity. */
export async function invitees(tx: Tx, activityId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT person_id FROM public.activity_invitees WHERE activity_id = ${activityId}
    ORDER BY person_id`);
  return rows.map((r) => r.person_id);
}

/** How many are called up to each of these activities. */
export async function inviteeCounts(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, number>> {
  if (activityIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ activity_id: string; n: number }>(sql`
    SELECT activity_id, count(*)::int AS n FROM public.activity_invitees
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])
    GROUP BY activity_id`);
  return new Map(rows.map((r) => [r.activity_id, r.n]));
}

export async function addInvitees(
  tx: Tx,
  input: { clubId: string; activityId: string; personIds: readonly string[]; invitedBy: string },
): Promise<void> {
  if (input.personIds.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.activity_invitees (club_id, activity_id, person_id, invited_by_person_id)
    SELECT ${input.clubId}, ${input.activityId}, p, ${input.invitedBy}
    FROM unnest(${uuidArray(input.personIds)}::uuid[]) AS p
    ON CONFLICT (activity_id, person_id) DO NOTHING`);
}

export async function removeInvitees(
  tx: Tx,
  activityId: string,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.activity_invitees
    WHERE activity_id = ${activityId} AND person_id = ANY (${uuidArray(personIds)}::uuid[])`);
}

// --- Call-ups in bulk and their revocations (P2.10) ---------------------------------

/** Who is called up to each of these activities. */
export async function inviteesOf(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>(activityIds.map((id) => [id, new Set<string>()]));
  if (activityIds.length === 0) return map;
  const { rows } = await tx.execute<{ activity_id: string; person_id: string }>(sql`
    SELECT activity_id, person_id FROM public.activity_invitees
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
  for (const r of rows) map.get(r.activity_id)?.add(r.person_id);
  return map;
}

/** The groups' participants (who take part without a call-up) of each activity. */
export async function groupParticipantsOf(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>(activityIds.map((id) => [id, new Set<string>()]));
  if (activityIds.length === 0) return map;
  const { rows } = await tx.execute<{ activity_id: string; person_id: string }>(sql`
    SELECT DISTINCT ag.activity_id, gm.person_id
    FROM public.activities a
    JOIN public.activity_groups ag ON ag.activity_id = a.id
    JOIN public.group_memberships gm ON gm.club_id = ag.club_id AND gm.group_id = ag.group_id
      AND gm.participates AND gm.valid_from <= a.starts_at
      AND (gm.valid_to IS NULL OR gm.valid_to > a.starts_at)
    WHERE a.id = ANY (${uuidArray(activityIds)}::uuid[])`);
  for (const r of rows) map.get(r.activity_id)?.add(r.person_id);
  return map;
}

/** The groups' leaders-only people of each activity (never called up). */
export async function groupLeadersOf(tx: Tx, activityId: string): Promise<Set<string>> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT r.person_id FROM (${rosterQuery([activityId], { wholeGroups: true })}) r
    WHERE r.role = 'leader'`);
  return new Set(rows.map((r) => r.person_id));
}

export async function addInviteePairs(
  tx: Tx,
  clubId: string,
  pairs: readonly { activityId: string; personId: string }[],
  invitedBy: string,
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.activity_invitees (club_id, activity_id, person_id, invited_by_person_id)
    SELECT ${clubId}::uuid, p."activityId", p."personId", ${invitedBy}::uuid
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p("activityId" uuid, "personId" uuid)
    ON CONFLICT (activity_id, person_id) DO NOTHING`);
}

export async function removeInviteePairs(
  tx: Tx,
  pairs: readonly { activityId: string; personId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.activity_invitees i
    USING jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p("activityId" uuid, "personId" uuid)
    WHERE i.activity_id = p."activityId" AND i.person_id = p."personId"`);
}

/** Records revocations (one reason for all; a newer one replaces an older). */
export async function addRevocations(
  tx: Tx,
  clubId: string,
  pairs: readonly { activityId: string; personId: string }[],
  reason: string,
  revokedBy: string | null,
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.activity_callup_revocations (club_id, activity_id, person_id, reason,
      revoked_by_person_id, revoked_at)
    SELECT ${clubId}::uuid, p."activityId", p."personId", ${reason}, ${revokedBy}::uuid, now()
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p("activityId" uuid, "personId" uuid)
    ON CONFLICT (activity_id, person_id) DO UPDATE SET reason = EXCLUDED.reason,
      revoked_by_person_id = EXCLUDED.revoked_by_person_id, revoked_at = EXCLUDED.revoked_at`);
}

/** A person called up again: their revocation goes. */
export async function removeRevocations(
  tx: Tx,
  pairs: readonly { activityId: string; personId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.activity_callup_revocations v
    USING jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p("activityId" uuid, "personId" uuid)
    WHERE v.activity_id = p."activityId" AND v.person_id = p."personId"`);
}

export interface RevocationRow {
  activityId: string;
  personId: string;
  reason: string;
  revokedByPersonId: string | null;
  revokedAt: Date;
}

/**
 * Revocations of these activities (all, or of these people: the person's own
 * view reads through own_read across clubs).
 */
export async function revocations(
  tx: Tx,
  activityIds: readonly string[],
  personIds: readonly string[] | null = null,
): Promise<RevocationRow[]> {
  if (activityIds.length === 0 || personIds?.length === 0) return [];
  const { rows } = await tx.execute<{
    activity_id: string;
    person_id: string;
    reason: string;
    revoked_by_person_id: string | null;
    revoked_at: string | Date;
  }>(sql`
    SELECT activity_id, person_id, reason, revoked_by_person_id, revoked_at
    FROM public.activity_callup_revocations
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])
      ${personIds ? sql`AND person_id = ANY (${uuidArray(personIds)}::uuid[])` : sql``}
    ORDER BY revoked_at, person_id`);
  return rows.map((r) => ({
    activityId: r.activity_id,
    personId: r.person_id,
    reason: r.reason,
    revokedByPersonId: r.revoked_by_person_id,
    revokedAt: new Date(r.revoked_at),
  }));
}

/** Sets invitees_only on these activities (one statement). */
export async function setInviteesOnly(
  tx: Tx,
  activityIds: readonly string[],
  value: boolean,
): Promise<void> {
  if (activityIds.length === 0) return;
  await tx.execute(sql`
    UPDATE public.activities SET invitees_only = ${value}
    WHERE id = ANY (${uuidArray(activityIds)}::uuid[]) AND invitees_only <> ${value}`);
}

// --- A series' call-up and its sessions' overrides (P2.10) ---------------------------------

export async function seriesInvitees(tx: Tx, seriesId: string): Promise<Set<string>> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT person_id FROM public.activity_series_invitees WHERE series_id = ${seriesId}`);
  return new Set(rows.map((r) => r.person_id));
}

export async function replaceSeriesInvitees(
  tx: Tx,
  clubId: string,
  seriesId: string,
  personIds: readonly string[],
  addedBy: string | null,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM public.activity_series_invitees
    WHERE series_id = ${seriesId} AND NOT (person_id = ANY (${uuidArray(personIds)}::uuid[]))`);
  if (personIds.length > 0) {
    await tx.execute(sql`
      INSERT INTO public.activity_series_invitees (club_id, series_id, person_id, added_by_person_id)
      SELECT ${clubId}::uuid, ${seriesId}::uuid, p, ${addedBy}::uuid
      FROM unnest(${uuidArray(personIds)}::uuid[]) AS p
      ON CONFLICT (series_id, person_id) DO NOTHING`);
  }
}

export type OverrideKind = "added" | "removed";

/** The overrides of these sessions: activity → person → kind. */
export async function overridesOf(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, Map<string, OverrideKind>>> {
  const map = new Map<string, Map<string, OverrideKind>>(
    activityIds.map((id) => [id, new Map<string, OverrideKind>()]),
  );
  if (activityIds.length === 0) return map;
  const { rows } = await tx.execute<{
    activity_id: string;
    person_id: string;
    kind: OverrideKind;
  }>(sql`
    SELECT activity_id, person_id, kind FROM public.activity_invitee_overrides
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
  for (const r of rows) map.get(r.activity_id)?.set(r.person_id, r.kind);
  return map;
}

export async function setOverride(
  tx: Tx,
  clubId: string,
  activityId: string,
  personId: string,
  kind: OverrideKind | null,
  by: string | null,
): Promise<void> {
  if (kind === null) {
    await tx.execute(sql`
      DELETE FROM public.activity_invitee_overrides
      WHERE activity_id = ${activityId} AND person_id = ${personId}`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO public.activity_invitee_overrides (club_id, activity_id, person_id, kind, set_by_person_id)
    VALUES (${clubId}, ${activityId}, ${personId}, ${kind}, ${by})
    ON CONFLICT (activity_id, person_id) DO UPDATE SET kind = EXCLUDED.kind,
      set_by_person_id = EXCLUDED.set_by_person_id`);
}

export async function deleteOverrides(tx: Tx, activityIds: readonly string[]): Promise<void> {
  if (activityIds.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.activity_invitee_overrides
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
}

/** Whether these activities belong to an event (ADR 0038: their call-up is the event's). */
export async function eventSessions(tx: Tx, activityIds: readonly string[]): Promise<Set<string>> {
  if (activityIds.length === 0) return new Set();
  // Read-only: the events module owns event_activities (as the schedule's query).
  const { rows } = await tx.execute<{ activity_id: string }>(sql`
    SELECT activity_id FROM public.event_activities
    WHERE activity_id = ANY (${uuidArray(activityIds)}::uuid[])`);
  return new Set(rows.map((r) => r.activity_id));
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

/**
 * The leaders' list: the roster with their answers (participants and, since
 * P2.7b, leaders, each with their role), given name first (keyset).
 */
export async function responseList(
  tx: Tx,
  activityId: string,
  page: { status: ResponseStatus | "none" | null; cursor: string | null; limit: number },
): Promise<(RosterRow & { response: ResponseRow | null })[]> {
  const { rows } = await tx.execute<{
    id: string | null;
    person_id: string;
    role: AttendanceRole;
    guest: boolean;
    status: ResponseStatus | null;
    note: string | null;
    responded_by_person_id: string | null;
    responded_at: string | null;
  }>(sql`
    SELECT * FROM (
      SELECT ar.id, r.person_id, r.role, r.guest, ar.status, ar.note, ar.responded_by_person_id, ar.responded_at,
        ${givenNameSortKey(sql`r.person_id`)} AS sort_key
      FROM (${rosterQuery([activityId])}) r
      LEFT JOIN public.activity_responses ar ON ar.activity_id = r.activity_id AND ar.person_id = r.person_id
      WHERE true
        ${page.status === "none" ? sql`AND ar.id IS NULL` : page.status ? sql`AND ar.status = ${page.status}` : sql``}
    ) x
    ${
      page.cursor
        ? sql`WHERE (x.sort_key, x.person_id) > (${givenNameSortKey(sql`${page.cursor}::uuid`)}, ${page.cursor}::uuid)`
        : sql``
    }
    ORDER BY x.sort_key, x.person_id
    LIMIT ${page.limit}`);
  return rows.map((r) => ({
    personId: r.person_id,
    role: r.role,
    guest: r.guest,
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
    g AS (
      SELECT gm.person_id, array_agg(tstzrange(gm.valid_from, gm.valid_to)) AS periods,
        ${givenNameSortKey(sql`gm.person_id`)} AS sort_key
      FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.group_id = ${groupId} AND gm.participates
        AND gm.valid_from < ${range.to} AND (gm.valid_to IS NULL OR gm.valid_to > ${range.from})
      GROUP BY gm.person_id
    ),
    m AS (
      SELECT * FROM g
      ${
        page.cursor
          ? sql`WHERE (g.sort_key, g.person_id) > (${givenNameSortKey(sql`${page.cursor}::uuid`)}, ${page.cursor}::uuid)`
          : sql``
      }
      ORDER BY g.sort_key, g.person_id
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
    GROUP BY m.person_id, m.periods, m.sort_key
    ORDER BY m.sort_key, m.person_id`;
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

/** The people who take part in these groups now (participating memberships; P2.7e). */
export async function groupParticipants(tx: Tx, groupIds: readonly string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT gm.person_id FROM public.group_memberships gm
    WHERE gm.group_id = ANY (${uuidArray(groupIds)}::uuid[]) AND gm.participates
      AND gm.valid_from <= now() AND (gm.valid_to IS NULL OR gm.valid_to > now())`);
  return rows.map((r) => r.person_id);
}
