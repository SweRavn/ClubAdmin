// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties' rows (P2.6 part A, ADR 0050): duty types, the club's
// duty settings, shifts (tasks of kind `duty_shift`, ADR 0052) with their
// assignments, quotas per group and season, and the facts sign-up needs
// (group participants, club members, birth dates; read-only). Every query
// runs in the caller's tenant transaction and starts from a key, a group or
// an activity (their indexes).

import { sql, type Tx } from "@clubadmin/db";
import type { DutyChildContact, DutyVisibility, TaskAssignmentStatus } from "@clubadmin/shared";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

// --- Duty types -------------------------------------------------------------------

export interface DutyTypeRow {
  id: string;
  name: string;
  instruction: string | null;
  instructionDocumentIds: string[];
  minAge: number | null;
  childContact: DutyChildContact;
  requiredQualifications: string[];
  archived: boolean;
}

type DutyTypeDb = {
  id: string;
  name: string;
  instruction: string | null;
  instruction_document_ids: string[];
  min_age: number | null;
  child_contact: DutyChildContact;
  required_qualifications: string[];
  archived_at: Date | null;
};
const toType = (r: DutyTypeDb): DutyTypeRow => ({
  id: r.id,
  name: r.name,
  instruction: r.instruction,
  instructionDocumentIds: r.instruction_document_ids,
  minAge: r.min_age,
  childContact: r.child_contact,
  requiredQualifications: r.required_qualifications,
  archived: r.archived_at !== null,
});
const TYPE_COLUMNS = sql`id, name, instruction, instruction_document_ids, min_age, child_contact,
  required_qualifications, archived_at`;

/** The club's duty types by name (at most 500: a catalogue, not a list that grows). */
export async function types(tx: Tx, includeArchived: boolean): Promise<DutyTypeRow[]> {
  const { rows } = await tx.execute<DutyTypeDb>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.duty_types
    WHERE ${includeArchived} OR archived_at IS NULL
    ORDER BY lower(name), id LIMIT 500`);
  return rows.map(toType);
}

export async function type(tx: Tx, typeId: string): Promise<DutyTypeRow | null> {
  const { rows } = await tx.execute<DutyTypeDb>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.duty_types WHERE id = ${typeId}::uuid`);
  return rows[0] ? toType(rows[0]) : null;
}

/** A new type; null when an active type has the name. */
export async function insertType(
  tx: Tx,
  clubId: string,
  input: Omit<DutyTypeRow, "id" | "archived">,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.duty_types (club_id, name, instruction, instruction_document_ids, min_age,
      child_contact, required_qualifications)
    VALUES (${clubId}, ${input.name}, ${input.instruction},
      ${uuidArray(input.instructionDocumentIds)}::uuid[], ${input.minAge}, ${input.childContact},
      ${JSON.stringify(input.requiredQualifications)}::jsonb)
    ON CONFLICT (club_id, lower(name)) WHERE archived_at IS NULL DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

export async function updateType(tx: Tx, row: DutyTypeRow): Promise<void> {
  await tx.execute(sql`
    UPDATE public.duty_types SET name = ${row.name}, instruction = ${row.instruction},
      instruction_document_ids = ${uuidArray(row.instructionDocumentIds)}::uuid[],
      min_age = ${row.minAge}, child_contact = ${row.childContact},
      required_qualifications = ${JSON.stringify(row.requiredQualifications)}::jsonb,
      archived_at = CASE WHEN ${row.archived} THEN coalesce(archived_at, now()) END
    WHERE id = ${row.id}::uuid`);
}

/** An active type other than this one with the name. */
export async function typeNameTaken(tx: Tx, name: string, exceptId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.duty_types
    WHERE lower(name) = lower(${name}) AND archived_at IS NULL AND id <> ${exceptId}::uuid`);
  return rows.length > 0;
}

// --- Settings -----------------------------------------------------------------------

export interface DutySettingsRow {
  visibility: DutyVisibility;
  groupsMayChangeVisibility: boolean;
  aloneWithChildrenForbidden: boolean;
}

export async function settings(tx: Tx): Promise<DutySettingsRow> {
  const { rows } = await tx.execute<{
    visibility: DutyVisibility;
    groups_may_change_visibility: boolean;
    alone_with_children_forbidden: boolean;
  }>(sql`
    SELECT visibility, groups_may_change_visibility, alone_with_children_forbidden
    FROM public.duty_settings WHERE club_id = app.current_club_id()`);
  const r = rows[0];
  return r
    ? {
        visibility: r.visibility,
        groupsMayChangeVisibility: r.groups_may_change_visibility,
        aloneWithChildrenForbidden: r.alone_with_children_forbidden,
      }
    : { visibility: "names", groupsMayChangeVisibility: false, aloneWithChildrenForbidden: false };
}

export async function putSettings(tx: Tx, clubId: string, row: DutySettingsRow): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.duty_settings (club_id, visibility, groups_may_change_visibility,
      alone_with_children_forbidden)
    VALUES (${clubId}, ${row.visibility}, ${row.groupsMayChangeVisibility},
      ${row.aloneWithChildrenForbidden})
    ON CONFLICT (club_id) DO UPDATE SET visibility = excluded.visibility,
      groups_may_change_visibility = excluded.groups_may_change_visibility,
      alone_with_children_forbidden = excluded.alone_with_children_forbidden`);
}

// --- Shifts -------------------------------------------------------------------------

export interface ShiftRow {
  id: string;
  clubId: string;
  groupId: string | null;
  groupName: string | null;
  dutyTypeId: string;
  typeName: string;
  minAge: number | null;
  childContact: DutyChildContact;
  typeArchived: boolean;
  title: string;
  note: string | null;
  startsAt: Date;
  endsAt: Date;
  locationId: string | null;
  locationName: string | null;
  activityId: string | null;
  eventId: string | null;
  needed: number;
}

type ShiftDb = {
  id: string;
  club_id: string;
  group_id: string | null;
  group_name: string | null;
  duty_type_id: string;
  type_name: string;
  min_age: number | null;
  child_contact: DutyChildContact;
  type_archived: boolean;
  title: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date;
  location_id: string | null;
  location_name: string | null;
  source_activity_id: string | null;
  source_event_id: string | null;
  needed: number;
};
const toShift = (r: ShiftDb): ShiftRow => ({
  id: r.id,
  clubId: r.club_id,
  groupId: r.group_id,
  groupName: r.group_name,
  dutyTypeId: r.duty_type_id,
  typeName: r.type_name,
  minAge: r.min_age,
  childContact: r.child_contact,
  typeArchived: r.type_archived,
  title: r.title,
  note: r.description,
  startsAt: new Date(r.starts_at),
  endsAt: new Date(r.ends_at),
  locationId: r.location_id,
  locationName: r.location_name,
  activityId: r.source_activity_id,
  eventId: r.source_event_id,
  needed: r.needed,
});
const SHIFT_SELECT = sql`
  SELECT t.id, t.club_id, t.group_id, g.name AS group_name, t.duty_type_id, dt.name AS type_name,
    dt.min_age, dt.child_contact, dt.archived_at IS NOT NULL AS type_archived, t.title,
    t.description, t.starts_at, t.ends_at, t.location_id, l.name AS location_name,
    t.source_activity_id, t.source_event_id, t.needed
  FROM public.tasks t
  JOIN public.duty_types dt ON dt.id = t.duty_type_id
  LEFT JOIN public.groups g ON g.id = t.group_id
  LEFT JOIN public.locations l ON l.id = t.location_id`;

/** A shift by key (locked for a change of its assignments when asked). */
export async function shift(tx: Tx, shiftId: string, lock = false): Promise<ShiftRow | null> {
  if (lock) {
    await tx.execute(sql`SELECT 1 FROM public.tasks WHERE id = ${shiftId}::uuid FOR UPDATE`);
  }
  const { rows } = await tx.execute<ShiftDb>(sql`
    ${SHIFT_SELECT} WHERE t.id = ${shiftId}::uuid AND t.kind = 'duty_shift'`);
  return rows[0] ? toShift(rows[0]) : null;
}

/** A group's shifts in a period (by its index), or the club's own (no group). */
export async function shifts(
  tx: Tx,
  where: { groupId: string } | { club: true } | { activityId: string },
  range: { from: Date; to: Date } | null,
  limit: number,
): Promise<ShiftRow[]> {
  const filter =
    "groupId" in where
      ? sql`t.group_id = ${where.groupId}::uuid AND t.kind = 'duty_shift'`
      : "club" in where
        ? sql`t.club_id = app.current_club_id() AND t.group_id IS NULL AND t.kind = 'duty_shift'`
        : sql`t.source_activity_id = ${where.activityId}::uuid AND t.kind = 'duty_shift'`;
  const period = range
    ? sql`AND t.starts_at < ${range.to.toISOString()}::timestamptz
          AND t.starts_at >= ${range.from.toISOString()}::timestamptz`
    : sql``;
  const { rows } = await tx.execute<ShiftDb>(sql`
    ${SHIFT_SELECT} WHERE ${filter} ${period} ORDER BY t.starts_at, t.id LIMIT ${limit}`);
  return rows.map(toShift);
}

export async function insertShift(
  tx: Tx,
  input: {
    clubId: string;
    groupId: string | null;
    dutyTypeId: string;
    title: string;
    note: string | null;
    startsAt: string;
    endsAt: string;
    locationId: string | null;
    needed: number;
    activityId: string | null;
    eventId: string | null;
    by: string;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.tasks (club_id, group_id, kind, title, description, starts_at, ends_at,
      needed, duty_type_id, location_id, source_activity_id, source_event_id, created_by_person_id)
    VALUES (${input.clubId}, ${input.groupId}, 'duty_shift', ${input.title}, ${input.note},
      ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.needed},
      ${input.dutyTypeId}, ${input.locationId}, ${input.activityId}, ${input.eventId}, ${input.by})
    RETURNING id`);
  return rows[0]!.id;
}

export async function updateShift(tx: Tx, row: ShiftRow): Promise<void> {
  await tx.execute(sql`
    UPDATE public.tasks SET title = ${row.title}, description = ${row.note},
      starts_at = ${row.startsAt.toISOString()}::timestamptz,
      ends_at = ${row.endsAt.toISOString()}::timestamptz, location_id = ${row.locationId},
      needed = ${row.needed}
    WHERE id = ${row.id}::uuid AND kind = 'duty_shift'`);
}

export async function deleteShift(tx: Tx, shiftId: string): Promise<void> {
  await tx.execute(
    sql`DELETE FROM public.tasks WHERE id = ${shiftId}::uuid AND kind = 'duty_shift'`,
  );
}

/** Whether a location is the club's and in use. */
export async function locationValid(tx: Tx, locationId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.locations WHERE id = ${locationId}::uuid AND archived_at IS NULL`);
  return rows.length > 0;
}

/** Whether an activity is the group's (or, without a group, the club's). */
export async function activityInGroup(
  tx: Tx,
  activityId: string,
  groupId: string | null,
): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT CASE WHEN ${groupId}::uuid IS NULL
      THEN EXISTS (SELECT 1 FROM public.activities a WHERE a.id = ${activityId}::uuid)
      ELSE EXISTS (SELECT 1 FROM public.activity_groups ag
        WHERE ag.activity_id = ${activityId}::uuid AND ag.group_id = ${groupId}::uuid) END AS ok`);
  return rows[0]?.ok === true;
}

export async function eventInGroup(
  tx: Tx,
  eventId: string,
  groupId: string | null,
): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT CASE WHEN ${groupId}::uuid IS NULL
      THEN EXISTS (SELECT 1 FROM public.events e WHERE e.id = ${eventId}::uuid)
      ELSE EXISTS (SELECT 1 FROM public.event_groups eg
        WHERE eg.event_id = ${eventId}::uuid AND eg.group_id = ${groupId}::uuid) END AS ok`);
  return rows[0]?.ok === true;
}

// --- Assignments --------------------------------------------------------------------

export interface AssignmentRow {
  id: string;
  shiftId: string;
  personId: string;
  countsForPersonId: string | null;
  source: "assigned" | "signup" | "swap";
  status: TaskAssignmentStatus;
}

/** The assignments of these shifts, by the task's unique index. */
export async function assignments(tx: Tx, shiftIds: readonly string[]): Promise<AssignmentRow[]> {
  if (shiftIds.length === 0) return [];
  const { rows } = await tx.execute<{
    id: string;
    task_id: string;
    person_id: string;
    counts_for_person_id: string | null;
    source: AssignmentRow["source"];
    status: TaskAssignmentStatus;
  }>(sql`
    SELECT id, task_id, person_id, counts_for_person_id, source, status
    FROM public.task_assignments
    WHERE task_id = ANY (${uuidArray([...new Set(shiftIds)])}::uuid[])
    ORDER BY created_at, id`);
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.task_id,
    personId: r.person_id,
    countsForPersonId: r.counts_for_person_id,
    source: r.source,
    status: r.status,
  }));
}

/** A new assignment; null when the person is on the shift already. */
export async function insertAssignment(
  tx: Tx,
  input: {
    clubId: string;
    shiftId: string;
    personId: string;
    countsForPersonId: string | null;
    source: "assigned" | "signup";
  },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.task_assignments (club_id, task_id, person_id, counts_for_person_id, source)
    VALUES (${input.clubId}, ${input.shiftId}, ${input.personId}, ${input.countsForPersonId},
      ${input.source})
    ON CONFLICT (task_id, person_id) DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

export async function deleteAssignment(tx: Tx, assignmentId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM public.task_assignments WHERE id = ${assignmentId}::uuid`);
}

// --- People (read-only facts) -------------------------------------------------------

/** Which of these people take part in the group (participants, open memberships). */
export async function groupParticipants(
  tx: Tx,
  groupId: string,
  personIds: readonly string[] | null,
): Promise<string[]> {
  const people = personIds
    ? sql`AND gm.person_id = ANY (${uuidArray([...new Set(personIds)])}::uuid[])`
    : sql``;
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT gm.person_id FROM public.group_memberships gm
    WHERE gm.group_id = ${groupId}::uuid AND gm.valid_to IS NULL AND gm.participates ${people}
    LIMIT 2000`);
  return rows.map((r) => r.person_id);
}

/** Which of these people are the club's active (or paused) members. */
export async function clubMembers(tx: Tx, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT m.person_id FROM public.club_memberships m
    WHERE m.club_id = app.current_club_id() AND m.valid_to IS NULL
      AND m.status IN ('active', 'paused')
      AND m.person_id = ANY (${uuidArray([...new Set(personIds)])}::uuid[])`);
  return new Set(rows.map((r) => r.person_id));
}

/** Birth dates, and whether the person has an active guardian (an unknown age is then a child's). */
export async function ages(
  tx: Tx,
  personIds: readonly string[],
): Promise<Map<string, { birthDate: string | null; hasGuardian: boolean }>> {
  if (personIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    id: string;
    birth_date: string | null;
    has_guardian: boolean;
  }>(sql`
    SELECT p.id, p.birth_date::text, EXISTS (SELECT 1 FROM public.guardianships g
      WHERE g.ward_person_id = p.id AND g.status = 'active' AND g.valid_to IS NULL) AS has_guardian
    FROM public.people p WHERE p.id = ANY (${uuidArray([...new Set(personIds)])}::uuid[])`);
  return new Map(rows.map((r) => [r.id, { birthDate: r.birth_date, hasGuardian: r.has_guardian }]));
}

/** The children a person may act for (active guardianships with the right). */
export async function wardsOf(tx: Tx, personId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ ward_person_id: string }>(sql`
    SELECT ward_person_id FROM public.guardianships
    WHERE guardian_person_id = ${personId}::uuid AND status = 'active' AND valid_to IS NULL
      AND 'act_on_behalf' = ANY (rights)`);
  return rows.map((r) => r.ward_person_id);
}

// --- Quotas -------------------------------------------------------------------------

export async function season(
  tx: Tx,
  seasonId: string,
): Promise<{ startsOn: string; endsOn: string } | null> {
  const { rows } = await tx.execute<{ starts_on: string; ends_on: string }>(sql`
    SELECT starts_on::text, ends_on::text FROM public.seasons WHERE id = ${seasonId}::uuid`);
  return rows[0] ? { startsOn: rows[0].starts_on, endsOn: rows[0].ends_on } : null;
}

export async function quota(tx: Tx, groupId: string, seasonId: string): Promise<number | null> {
  const { rows } = await tx.execute<{ shifts_per_player: number }>(sql`
    SELECT shifts_per_player FROM public.duty_quotas
    WHERE group_id = ${groupId}::uuid AND season_id = ${seasonId}::uuid`);
  return rows[0]?.shifts_per_player ?? null;
}

export async function putQuota(
  tx: Tx,
  input: { clubId: string; groupId: string; seasonId: string; shiftsPerPlayer: number | null },
): Promise<void> {
  if (input.shiftsPerPlayer === null) {
    await tx.execute(sql`
      DELETE FROM public.duty_quotas
      WHERE group_id = ${input.groupId}::uuid AND season_id = ${input.seasonId}::uuid`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO public.duty_quotas (club_id, group_id, season_id, shifts_per_player)
    VALUES (${input.clubId}, ${input.groupId}, ${input.seasonId}, ${input.shiftsPerPlayer})
    ON CONFLICT (group_id, season_id) DO UPDATE SET shifts_per_player = excluded.shifts_per_player`);
}

/**
 * The group's shifts in the period counted per player (the person it counts
 * for): done and planned. A shift of the club (no group) counts too.
 */
export async function quotaCounts(
  tx: Tx,
  groupId: string,
  seasonId: string,
  timeZone: string,
): Promise<Map<string, { done: number; planned: number }>> {
  const { rows } = await tx.execute<{ person_id: string; done: number; planned: number }>(sql`
    SELECT a.counts_for_person_id AS person_id,
      count(*) FILTER (WHERE a.status = 'done')::int AS done,
      count(*) FILTER (WHERE a.status = 'planned')::int AS planned
    FROM public.tasks t JOIN public.task_assignments a ON a.task_id = t.id
    WHERE t.kind = 'duty_shift' AND a.counts_for_person_id IS NOT NULL
      AND (t.group_id = ${groupId}::uuid
        OR (t.group_id IS NULL AND t.club_id = app.current_club_id()))
      -- The season's days in the club's time zone.
      AND t.starts_at >= (SELECT s.starts_on::timestamp AT TIME ZONE ${timeZone}
        FROM public.seasons s WHERE s.id = ${seasonId}::uuid)
      AND t.starts_at < (SELECT (s.ends_on + 1)::timestamp AT TIME ZONE ${timeZone}
        FROM public.seasons s WHERE s.id = ${seasonId}::uuid)
    GROUP BY a.counts_for_person_id`);
  return new Map(rows.map((r) => [r.person_id, { done: r.done, planned: r.planned }]));
}
