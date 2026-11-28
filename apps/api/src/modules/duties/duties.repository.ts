// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties' rows (P2.6 part A, ADR 0050): duty types, the club's
// duty settings, shifts (tasks of kind `duty_shift`, ADR 0052) with their
// assignments, quotas per group and season, and the facts sign-up needs
// (group participants, club members, birth dates; read-only). Every query
// runs in the caller's tenant transaction and starts from a key, a group or
// an activity (their indexes).

import { sql, type Tx } from "@clubadmin/db";
import type {
  BackgroundCheckCategory,
  DutyChildContact,
  DutyVisibility,
  TaskAssignmentStatus,
} from "@clubadmin/shared";

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
  /** P2.8: the club's stricter background-check category for the type (null: from the contact). */
  checkCategory: BackgroundCheckCategory | null;
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
  check_category: BackgroundCheckCategory | null;
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
  checkCategory: r.check_category,
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
    dt.min_age, dt.child_contact, dt.background_check_category AS check_category,
    dt.archived_at IS NOT NULL AS type_archived, t.title,
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
    WHERE gm.group_id = ${groupId}::uuid AND gm.valid_to IS NULL AND gm.participates AND NOT gm.guest ${people}
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

// --- Marking (part B) ----------------------------------------------------------------

/** An assignment's status as marked by a planner; null when not on this shift. */
export async function setStatus(
  tx: Tx,
  input: { shiftId: string; assignmentId: string; status: TaskAssignmentStatus; by: string },
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.task_assignments SET status = ${input.status},
      marked_by_person_id = CASE WHEN ${input.status} = 'planned' THEN NULL ELSE ${input.by}::uuid END,
      marked_at = CASE WHEN ${input.status} = 'planned' THEN NULL ELSE now() END
    WHERE id = ${input.assignmentId}::uuid AND task_id = ${input.shiftId}::uuid
    RETURNING id`);
  return rows.length > 0;
}

/** Past shifts of a group (or the club's own) with someone still planned: "Att markera". */
export async function toMark(
  tx: Tx,
  where: { groupId: string } | { club: true },
  before: Date,
  limit: number,
): Promise<ShiftRow[]> {
  const filter =
    "groupId" in where
      ? sql`t.group_id = ${where.groupId}::uuid AND t.kind = 'duty_shift'`
      : sql`t.club_id = app.current_club_id() AND t.group_id IS NULL AND t.kind = 'duty_shift'`;
  const { rows } = await tx.execute<ShiftDb>(sql`
    ${SHIFT_SELECT} WHERE ${filter} AND t.ends_at <= ${before.toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM public.task_assignments a
        WHERE a.task_id = t.id AND a.status = 'planned')
    ORDER BY t.starts_at DESC, t.id LIMIT ${limit}`);
  return rows.map(toShift);
}

// --- A group's visibility (part B) ---------------------------------------------------

export async function groupVisibility(tx: Tx, groupId: string): Promise<DutyVisibility | null> {
  const { rows } = await tx.execute<{ visibility: DutyVisibility }>(sql`
    SELECT visibility FROM public.group_duty_settings WHERE group_id = ${groupId}::uuid`);
  return rows[0]?.visibility ?? null;
}

/** The groups' own visibility (when set). */
export async function groupVisibilities(
  tx: Tx,
  groupIds: readonly string[],
): Promise<Map<string, DutyVisibility>> {
  if (groupIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ group_id: string; visibility: DutyVisibility }>(sql`
    SELECT group_id, visibility FROM public.group_duty_settings
    WHERE group_id = ANY (${uuidArray([...new Set(groupIds)])}::uuid[])`);
  return new Map(rows.map((r) => [r.group_id, r.visibility]));
}

export async function putGroupVisibility(
  tx: Tx,
  input: { clubId: string; groupId: string; visibility: DutyVisibility | null },
): Promise<void> {
  if (input.visibility === null) {
    await tx.execute(
      sql`DELETE FROM public.group_duty_settings WHERE group_id = ${input.groupId}::uuid`,
    );
    return;
  }
  await tx.execute(sql`
    INSERT INTO public.group_duty_settings (club_id, group_id, visibility)
    VALUES (${input.clubId}, ${input.groupId}, ${input.visibility})
    ON CONFLICT (group_id) DO UPDATE SET visibility = excluded.visibility`);
}

// --- Swaps (part B) -----------------------------------------------------------------

export interface SwapRow {
  id: string;
  assignmentId: string;
  kind: "offer" | "request";
  status: "open" | "done" | "declined" | "withdrawn";
  createdByPersonId: string;
  takerPersonId: string | null;
  takerCountsForPersonId: string | null;
  shiftId: string;
  holderPersonId: string;
}

type SwapDb = {
  id: string;
  assignment_id: string;
  kind: SwapRow["kind"];
  status: SwapRow["status"];
  created_by_person_id: string;
  taker_person_id: string | null;
  taker_counts_for_person_id: string | null;
  task_id: string;
  person_id: string;
};
const toSwap = (r: SwapDb): SwapRow => ({
  id: r.id,
  assignmentId: r.assignment_id,
  kind: r.kind,
  status: r.status,
  createdByPersonId: r.created_by_person_id,
  takerPersonId: r.taker_person_id,
  takerCountsForPersonId: r.taker_counts_for_person_id,
  shiftId: r.task_id,
  holderPersonId: r.person_id,
});
const SWAP_SELECT = sql`
  SELECT s.id, s.assignment_id, s.kind, s.status, s.created_by_person_id, s.taker_person_id,
    s.taker_counts_for_person_id, a.task_id, a.person_id
  FROM public.task_swaps s JOIN public.task_assignments a ON a.id = s.assignment_id`;

/** An assignment by key with its shift (for swaps); null when none. */
export async function assignment(tx: Tx, assignmentId: string): Promise<AssignmentRow | null> {
  const { rows } = await tx.execute<{
    id: string;
    task_id: string;
    person_id: string;
    counts_for_person_id: string | null;
    source: AssignmentRow["source"];
    status: TaskAssignmentStatus;
  }>(sql`
    SELECT a.id, a.task_id, a.person_id, a.counts_for_person_id, a.source, a.status
    FROM public.task_assignments a JOIN public.tasks t ON t.id = a.task_id AND t.kind = 'duty_shift'
    WHERE a.id = ${assignmentId}::uuid`);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        shiftId: r.task_id,
        personId: r.person_id,
        countsForPersonId: r.counts_for_person_id,
        source: r.source,
        status: r.status,
      }
    : null;
}

export async function insertSwap(
  tx: Tx,
  input: {
    clubId: string;
    assignmentId: string;
    kind: "offer" | "request";
    by: string;
    takerPersonId: string | null;
    takerCountsForPersonId: string | null;
  },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.task_swaps (club_id, assignment_id, kind, created_by_person_id,
      taker_person_id, taker_counts_for_person_id)
    VALUES (${input.clubId}, ${input.assignmentId}, ${input.kind}, ${input.by},
      ${input.takerPersonId}, ${input.takerCountsForPersonId})
    ON CONFLICT (assignment_id) WHERE status = 'open' AND kind = 'offer' DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

/** A swap by key, locked with its assignment's shift when asked. */
export async function swap(tx: Tx, swapId: string): Promise<SwapRow | null> {
  const { rows } = await tx.execute<SwapDb>(
    sql`${SWAP_SELECT} WHERE s.id = ${swapId}::uuid FOR UPDATE OF s`,
  );
  return rows[0] ? toSwap(rows[0]) : null;
}

/** Open swaps of these shifts. */
export async function openSwaps(tx: Tx, shiftIds: readonly string[]): Promise<SwapRow[]> {
  if (shiftIds.length === 0) return [];
  const { rows } = await tx.execute<SwapDb>(sql`
    ${SWAP_SELECT} WHERE s.status = 'open'
      AND a.task_id = ANY (${uuidArray([...new Set(shiftIds)])}::uuid[])
    ORDER BY s.created_at, s.id`);
  return rows.map(toSwap);
}

export async function closeSwap(
  tx: Tx,
  swapId: string,
  status: "done" | "declined" | "withdrawn",
  taker?: { personId: string; countsForPersonId: string | null },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.task_swaps SET status = ${status}, decided_at = now(),
      taker_person_id = coalesce(${taker?.personId ?? null}::uuid, taker_person_id),
      taker_counts_for_person_id = CASE WHEN ${taker !== undefined}
        THEN ${taker?.countsForPersonId ?? null}::uuid ELSE taker_counts_for_person_id END
    WHERE id = ${swapId}::uuid`);
}

/** The shift changes hands: the assignment goes to the taker (other open swaps of it end). */
export async function transfer(
  tx: Tx,
  input: { assignmentId: string; personId: string; countsForPersonId: string | null },
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.task_assignments SET person_id = ${input.personId},
      counts_for_person_id = ${input.countsForPersonId}, source = 'swap'
    WHERE id = ${input.assignmentId}::uuid
      AND NOT EXISTS (SELECT 1 FROM public.task_assignments o
        WHERE o.task_id = task_assignments.task_id AND o.person_id = ${input.personId}::uuid)
    RETURNING id`);
  if (rows.length === 0) return false;
  await tx.execute(sql`
    UPDATE public.task_swaps SET status = 'withdrawn', decided_at = now()
    WHERE assignment_id = ${input.assignmentId}::uuid AND status = 'open'`);
  return true;
}

// --- "Mina uppgifter" (part B) --------------------------------------------------------

/** The groups where these people take part (open memberships). */
export async function participations(
  tx: Tx,
  personIds: readonly string[],
): Promise<{ personId: string; groupId: string; groupName: string }[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{ person_id: string; group_id: string; name: string }>(sql`
    SELECT DISTINCT gm.person_id, gm.group_id, g.name FROM public.group_memberships gm
    JOIN public.groups g ON g.id = gm.group_id
    WHERE gm.person_id = ANY (${uuidArray([...new Set(personIds)])}::uuid[])
      AND gm.valid_to IS NULL AND gm.participates AND NOT gm.guest AND g.club_id = app.current_club_id()`);
  return rows.map((r) => ({ personId: r.person_id, groupId: r.group_id, groupName: r.name }));
}

/** Coming shifts of these groups (and the club's own) with a free place. */
export async function openShifts(
  tx: Tx,
  groupIds: readonly string[],
  range: { from: Date; to: Date },
  limit: number,
): Promise<ShiftRow[]> {
  const { rows } = await tx.execute<ShiftDb>(sql`
    ${SHIFT_SELECT}
    WHERE t.kind = 'duty_shift'
      AND (t.group_id = ANY (${uuidArray([...new Set(groupIds)])}::uuid[])
        OR (t.group_id IS NULL AND t.club_id = app.current_club_id()))
      AND t.starts_at >= ${range.from.toISOString()}::timestamptz
      AND t.starts_at < ${range.to.toISOString()}::timestamptz
      AND (SELECT count(*) FROM public.task_assignments a WHERE a.task_id = t.id) < t.needed
    ORDER BY t.starts_at, t.id LIMIT ${limit}`);
  return rows.map(toShift);
}

/** The season covering a day in the club, if any (the newest). */
export async function seasonOn(tx: Tx, day: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.seasons
    WHERE club_id = app.current_club_id() AND starts_on <= ${day}::date AND ends_on >= ${day}::date
    ORDER BY starts_on DESC LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** The groups' quotas in a season. */
export async function quotas(
  tx: Tx,
  groupIds: readonly string[],
  seasonId: string,
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ group_id: string; shifts_per_player: number }>(sql`
    SELECT group_id, shifts_per_player FROM public.duty_quotas
    WHERE season_id = ${seasonId}::uuid
      AND group_id = ANY (${uuidArray([...new Set(groupIds)])}::uuid[])`);
  return new Map(rows.map((r) => [r.group_id, r.shifts_per_player]));
}

// --- Statistics (part B) --------------------------------------------------------------

export interface StatsRow {
  personId: string;
  countsForPersonId: string | null;
  status: TaskAssignmentStatus;
  minutes: number;
  shiftTitle: string;
  startsAt: Date;
}

/** Every assignment of the group's shifts (and the club's own) in the season. */
export async function stats(
  tx: Tx,
  groupId: string,
  seasonId: string,
  timeZone: string,
): Promise<StatsRow[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    counts_for_person_id: string | null;
    status: TaskAssignmentStatus;
    minutes: number;
    title: string;
    starts_at: Date;
  }>(sql`
    SELECT a.person_id, a.counts_for_person_id, a.status,
      (extract(epoch FROM t.ends_at - t.starts_at) / 60)::int AS minutes, t.title, t.starts_at
    FROM public.tasks t JOIN public.task_assignments a ON a.task_id = t.id
    WHERE t.kind = 'duty_shift'
      AND (t.group_id = ${groupId}::uuid OR (t.group_id IS NULL AND t.club_id = app.current_club_id()))
      AND t.starts_at >= (SELECT s.starts_on::timestamp AT TIME ZONE ${timeZone}
        FROM public.seasons s WHERE s.id = ${seasonId}::uuid)
      AND t.starts_at < (SELECT (s.ends_on + 1)::timestamp AT TIME ZONE ${timeZone}
        FROM public.seasons s WHERE s.id = ${seasonId}::uuid)
    ORDER BY t.starts_at, a.id LIMIT 20000`);
  return rows.map((r) => ({
    personId: r.person_id,
    countsForPersonId: r.counts_for_person_id,
    status: r.status,
    minutes: r.minutes,
    shiftTitle: r.title,
    startsAt: new Date(r.starts_at),
  }));
}

// --- "Mitt schema" (part B) -----------------------------------------------------------

export interface MyDutyRow {
  assignmentId: string;
  shiftId: string;
  clubId: string;
  clubName: string;
  timeZone: string;
  groupId: string | null;
  groupName: string | null;
  title: string;
  typeName: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string | null;
  activityId: string | null;
  personId: string;
  countsForPersonId: string | null;
  status: TaskAssignmentStatus;
  changedAt: Date;
}

/** The caller's and their wards' shifts in a period, across their clubs (app.my_duty_shifts). */
export async function myDutyShifts(
  tx: Tx,
  range: { from: Date; to: Date },
  limit: number,
): Promise<MyDutyRow[]> {
  const { rows } = await tx.execute<{
    assignment_id: string;
    shift_id: string;
    club_id: string;
    club_name: string;
    time_zone: string;
    group_id: string | null;
    group_name: string | null;
    title: string;
    type_name: string;
    starts_at: Date;
    ends_at: Date;
    location_name: string | null;
    activity_id: string | null;
    person_id: string;
    counts_for_person_id: string | null;
    status: TaskAssignmentStatus;
    changed_at: Date;
  }>(sql`
    SELECT * FROM app.my_duty_shifts(${range.from.toISOString()}::timestamptz,
      ${range.to.toISOString()}::timestamptz, ${limit})`);
  return rows
    .map((r) => ({
      assignmentId: r.assignment_id,
      shiftId: r.shift_id,
      clubId: r.club_id,
      clubName: r.club_name,
      timeZone: r.time_zone,
      groupId: r.group_id,
      groupName: r.group_name,
      title: r.title,
      typeName: r.type_name,
      startsAt: new Date(r.starts_at),
      endsAt: new Date(r.ends_at),
      locationName: r.location_name,
      activityId: r.activity_id,
      personId: r.person_id,
      countsForPersonId: r.counts_for_person_id,
      status: r.status,
      changedAt: new Date(r.changed_at),
    }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, limit);
}

// --- Programmes (P2.9) -------------------------------------------------------------

/** Shifts of a programme (optionally starting in a range), of activities or of an event. */
export async function shiftsOf(
  tx: Tx,
  where:
    | { programmeId: string; range: { from: Date; to: Date } | null }
    | { activityIds: readonly string[] }
    | { eventId: string },
): Promise<ShiftRow[]> {
  let filter;
  if ("programmeId" in where) {
    filter = where.range
      ? sql`t.programme_id = ${where.programmeId}::uuid
          AND t.starts_at >= ${where.range.from.toISOString()}::timestamptz
          AND t.starts_at < ${where.range.to.toISOString()}::timestamptz`
      : sql`t.programme_id = ${where.programmeId}::uuid`;
  } else if ("activityIds" in where) {
    if (where.activityIds.length === 0) return [];
    filter = sql`t.source_activity_id = ANY (${uuidArray([...new Set(where.activityIds)])}::uuid[])`;
  } else {
    filter = sql`t.source_event_id = ${where.eventId}::uuid`;
  }
  const { rows } = await tx.execute<ShiftDb>(sql`
    ${SHIFT_SELECT} WHERE ${filter} AND t.kind = 'duty_shift'
    ORDER BY t.starts_at, t.id LIMIT 1000`);
  return rows.map(toShift);
}

/** Many shifts in one statement (laying out a programme). */
export async function insertShifts(
  tx: Tx,
  rows: readonly {
    id: string;
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
    programmeId: string;
    by: string;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.tasks (id, club_id, group_id, kind, title, description, starts_at, ends_at,
      needed, duty_type_id, location_id, source_activity_id, source_event_id, programme_id,
      created_by_person_id)
    SELECT r.id, r."clubId", r."groupId", 'duty_shift', r.title, r.note, r."startsAt", r."endsAt",
      r.needed, r."dutyTypeId", r."locationId", r."activityId", r."eventId", r."programmeId", r.by
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(id uuid, "clubId" uuid,
      "groupId" uuid, title text, note text, "startsAt" timestamptz, "endsAt" timestamptz,
      needed integer, "dutyTypeId" uuid, "locationId" uuid, "activityId" uuid, "eventId" uuid,
      "programmeId" uuid, by uuid)`);
}

export async function deleteShifts(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.tasks WHERE id = ANY (${uuidArray(ids)}::uuid[]) AND kind = 'duty_shift'`);
}

/** Duty types by ID (archived ones too). */
export async function typesById(tx: Tx, ids: readonly string[]): Promise<DutyTypeRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<DutyTypeDb>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.duty_types WHERE id = ANY (${uuidArray([...new Set(ids)])}::uuid[])`);
  return rows.map(toType);
}

/** Puts shifts that belong to no programme in this one (P2.9). */
export async function setProgramme(
  tx: Tx,
  programmeId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    UPDATE public.tasks SET programme_id = ${programmeId}::uuid
    WHERE id = ANY (${uuidArray(ids)}::uuid[]) AND programme_id IS NULL AND kind = 'duty_shift'`);
}
