// SPDX-License-Identifier: AGPL-3.0-only
// Queries on events, their audience groups and activities, and the
// registrations (P1.6, ADR 0038). IDs only towards people: no query here
// reads names. The queue is `queued_at` order among waiting registrations.

import { and, asc, eq, inArray, schema, type SQL, sql, type Tx } from "@clubadmin/db";
import type { RegistrationStatus } from "@clubadmin/shared";

import { givenNameSortKey } from "../people/index.ts";

const { events, eventGroups, eventActivities, eventRegistrations } = schema;

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type RegistrationRow = typeof eventRegistrations.$inferSelect;
export type NewRegistrationRow = typeof eventRegistrations.$inferInsert;

/** A uuid[] parameter (IDs only; validated as UUIDs where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

// --- Events ------------------------------------------------------------------------

export async function insertEvent(tx: Tx, row: NewEventRow): Promise<EventRow> {
  const [inserted] = await tx.insert(events).values(row).returning();
  return inserted!;
}

export async function findEvent(tx: Tx, id: string): Promise<EventRow | null> {
  const [row] = await tx.select().from(events).where(eq(events.id, id));
  return row ?? null;
}

/** The event row locked: registrations on one event are decided one at a time. */
export async function lockEvent(tx: Tx, id: string): Promise<EventRow | null> {
  const [row] = await tx.select().from(events).where(eq(events.id, id)).for("update");
  return row ?? null;
}

export async function updateEvent(
  tx: Tx,
  id: string,
  values: Partial<NewEventRow>,
): Promise<EventRow> {
  const [row] = await tx.update(events).set(values).where(eq(events.id, id)).returning();
  return row!;
}

export async function deleteEvent(tx: Tx, id: string): Promise<void> {
  await tx.delete(events).where(eq(events.id, id));
}

export async function insertEventGroups(
  tx: Tx,
  clubId: string,
  eventId: string,
  groupIds: readonly string[],
): Promise<void> {
  if (groupIds.length === 0) return;
  await tx.insert(eventGroups).values(groupIds.map((groupId) => ({ clubId, eventId, groupId })));
}

/** The audience groups of these events. */
export async function groupsOfEvents(
  tx: Tx,
  eventIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (eventIds.length === 0) return map;
  const rows = await tx
    .select({ eventId: eventGroups.eventId, groupId: eventGroups.groupId })
    .from(eventGroups)
    .where(inArray(eventGroups.eventId, [...eventIds]));
  for (const r of rows) map.set(r.eventId, [...(map.get(r.eventId) ?? []), r.groupId]);
  return map;
}

/** The activities of these events. */
export async function activitiesOfEvents(
  tx: Tx,
  eventIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (eventIds.length === 0) return map;
  const rows = await tx
    .select({ eventId: eventActivities.eventId, activityId: eventActivities.activityId })
    .from(eventActivities)
    .where(inArray(eventActivities.eventId, [...eventIds]))
    .orderBy(asc(eventActivities.createdAt));
  for (const r of rows) map.set(r.eventId, [...(map.get(r.eventId) ?? []), r.activityId]);
  return map;
}

/** The events these activities belong to (an activity belongs to at most one). */
export async function eventsOfActivities(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, string>> {
  if (activityIds.length === 0) return new Map();
  const rows = await tx
    .select({ eventId: eventActivities.eventId, activityId: eventActivities.activityId })
    .from(eventActivities)
    .where(inArray(eventActivities.activityId, [...activityIds]));
  return new Map(rows.map((r) => [r.activityId, r.eventId]));
}

export async function addEventActivities(
  tx: Tx,
  clubId: string,
  eventId: string,
  activityIds: readonly string[],
): Promise<void> {
  if (activityIds.length === 0) return;
  await tx
    .insert(eventActivities)
    .values(activityIds.map((activityId) => ({ clubId, eventId, activityId })));
}

export async function removeEventActivities(
  tx: Tx,
  eventId: string,
  activityIds: readonly string[],
): Promise<void> {
  if (activityIds.length === 0) return;
  await tx
    .delete(eventActivities)
    .where(
      and(
        eq(eventActivities.eventId, eventId),
        inArray(eventActivities.activityId, [...activityIds]),
      ),
    );
}

/**
 * Which events a list may hold: everything (club managers, registrars), or
 * those whose audience is the whole club or one of these groups (the
 * viewer's and their wards' groups, owned groups and their descendants),
 * plus drafts of the club (organisers; the caller filters each with the
 * policy).
 */
export type EventScope =
  | { all: true }
  | { all: false; groupIds: readonly string[]; ownedGroupIds: readonly string[]; drafts: boolean };

export interface EventPageInput {
  clubId: string;
  groupId: string | null;
  scope: EventScope;
  from: Date | null;
  to: Date | null;
  cursor: string | null;
  limit: number;
}

/** A page of the club's (or a group's) events in (starts_at, id) order. */
export async function listEvents(tx: Tx, input: EventPageInput): Promise<EventRow[]> {
  const conditions: SQL[] = [sql`e.club_id = ${input.clubId}`];
  if (input.groupId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM public.event_groups g WHERE g.event_id = e.id AND g.group_id = ${input.groupId})`,
    );
  }
  // Events that have not ended by `from` (an event in progress is still listed).
  if (input.from) conditions.push(sql`e.ends_at > ${input.from}`);
  if (input.to) conditions.push(sql`e.starts_at < ${input.to}`);
  if (!input.scope.all) {
    const { groupIds, ownedGroupIds, drafts } = input.scope;
    conditions.push(sql`(
      ${drafts ? sql`e.status = 'draft' OR` : sql``}
      (e.status <> 'draft' AND (e.audience = 'club' OR EXISTS (
        SELECT 1 FROM public.event_groups g WHERE g.event_id = e.id AND (
          g.group_id = ANY (${uuidArray(groupIds)}::uuid[])
          OR g.group_id IN (
            WITH RECURSIVE below AS (
              SELECT id FROM public.groups WHERE id = ANY (${uuidArray(ownedGroupIds)}::uuid[])
              UNION SELECT c.id FROM public.groups c JOIN below b ON c.parent_group_id = b.id
            ) SELECT id FROM below)))))
    )`);
  }
  if (input.cursor) {
    conditions.push(
      sql`(e.starts_at, e.id) > (SELECT c.starts_at, c.id FROM public.events c WHERE c.id = ${input.cursor})`,
    );
  }
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT e.id FROM public.events e
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY e.starts_at, e.id
    LIMIT ${input.limit}`);
  return eventsInOrder(
    tx,
    rows.map((r) => r.id),
  );
}

/**
 * Events open to these people or holding a registration of theirs, across
 * clubs (row-level security: the actor's clubs), not yet ended, in
 * (starts_at, id) order: club events of their clubs, events of their
 * groups (as members), and events they are registered to.
 */
export async function eventsForPeople(
  tx: Tx,
  input: { personIds: readonly string[]; now: Date; cursor: string | null; limit: number },
): Promise<EventRow[]> {
  if (input.personIds.length === 0) return [];
  const people = uuidArray(input.personIds);
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT e.id FROM public.events e
    WHERE e.status <> 'draft' AND e.ends_at > ${input.now}
      AND (
        (e.audience = 'club' AND EXISTS (
          SELECT 1 FROM public.club_memberships m
          WHERE m.club_id = e.club_id AND m.person_id = ANY (${people}::uuid[])
            AND m.valid_to IS NULL AND m.status IN ('active', 'paused')))
        OR EXISTS (
          SELECT 1 FROM public.event_groups g
          JOIN public.group_memberships gm ON gm.group_id = g.group_id
          WHERE g.event_id = e.id AND gm.person_id = ANY (${people}::uuid[])
            AND gm.function = 'member' AND gm.valid_to IS NULL)
        OR EXISTS (
          SELECT 1 FROM public.event_registrations r
          WHERE r.event_id = e.id AND r.person_id = ANY (${people}::uuid[])))
      ${
        input.cursor
          ? sql`AND (e.starts_at, e.id) > (SELECT c.starts_at, c.id FROM public.events c WHERE c.id = ${input.cursor})`
          : sql``
      }
    ORDER BY e.starts_at, e.id
    LIMIT ${input.limit}`);
  return eventsInOrder(
    tx,
    rows.map((r) => r.id),
  );
}

async function eventsInOrder(tx: Tx, ids: readonly string[]): Promise<EventRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(events)
    .where(inArray(events.id, [...ids]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// --- Registrations ----------------------------------------------------------------------

export interface EventCountsRow {
  confirmed: number;
  offered: number;
  waiting: number;
}

/** Counts per event: one grouped statement for a page of events. */
export async function countsOf(
  tx: Tx,
  eventIds: readonly string[],
): Promise<Map<string, EventCountsRow>> {
  const map = new Map<string, EventCountsRow>();
  if (eventIds.length === 0) return map;
  const { rows } = await tx.execute<{
    event_id: string;
    confirmed: number;
    offered: number;
    waiting: number;
  }>(sql`
    SELECT event_id,
      count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
      count(*) FILTER (WHERE status = 'offered')::int AS offered,
      count(*) FILTER (WHERE status = 'waitlisted')::int AS waiting
    FROM public.event_registrations
    WHERE event_id = ANY (${uuidArray(eventIds)}::uuid[])
      AND status IN ('confirmed', 'offered', 'waitlisted')
    GROUP BY event_id`);
  for (const r of rows) {
    map.set(r.event_id, { confirmed: r.confirmed, offered: r.offered, waiting: r.waiting });
  }
  return map;
}

/** The open registration (confirmed, waiting or offered) of a person, locked. */
export async function lockOpenRegistration(
  tx: Tx,
  eventId: string,
  personId: string,
): Promise<RegistrationRow | null> {
  const [row] = await tx
    .select()
    .from(eventRegistrations)
    .where(
      and(
        eq(eventRegistrations.eventId, eventId),
        eq(eventRegistrations.personId, personId),
        inArray(eventRegistrations.status, ["confirmed", "waitlisted", "offered"]),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function insertRegistration(
  tx: Tx,
  row: NewRegistrationRow,
): Promise<RegistrationRow> {
  const [inserted] = await tx.insert(eventRegistrations).values(row).returning();
  return inserted!;
}

export async function updateRegistration(
  tx: Tx,
  id: string,
  values: Partial<NewRegistrationRow>,
): Promise<RegistrationRow> {
  const [row] = await tx
    .update(eventRegistrations)
    .set(values)
    .where(eq(eventRegistrations.id, id))
    .returning();
  return row!;
}

/** The next waiting registrations in queue order (the event is locked). */
export async function nextWaiting(
  tx: Tx,
  eventId: string,
  limit: number,
): Promise<RegistrationRow[]> {
  if (limit <= 0) return [];
  return tx
    .select()
    .from(eventRegistrations)
    .where(
      and(eq(eventRegistrations.eventId, eventId), eq(eventRegistrations.status, "waitlisted")),
    )
    .orderBy(asc(eventRegistrations.queuedAt), asc(eventRegistrations.id))
    .limit(limit);
}

/** Confirmed participants of an event (IDs, given name first; the call-up of its activities). */
export async function confirmedPeople(tx: Tx, eventId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: eventRegistrations.personId })
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.eventId, eventId), eq(eventRegistrations.status, "confirmed")))
    .orderBy(
      givenNameSortKey(sql`${eventRegistrations.personId}`),
      asc(eventRegistrations.personId),
    );
  return rows.map((r) => r.personId);
}

/** Whether a question has been answered by anyone (it may not change type or go away). */
export async function answeredQuestionIds(tx: Tx, eventId: string): Promise<Set<string>> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT jsonb_object_keys(answers) AS id FROM public.event_registrations
    WHERE event_id = ${eventId}`);
  return new Set(rows.map((r) => r.id));
}

export async function hasSensitiveAnswers(tx: Tx, eventId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM public.event_registrations
    WHERE event_id = ${eventId} AND sensitive_answers IS NOT NULL LIMIT 1`);
  return rows.length > 0;
}

/** Registrations of these people to these events (the latest per event and person). */
export async function registrationsOf(
  tx: Tx,
  eventIds: readonly string[],
  personIds: readonly string[],
): Promise<RegistrationRow[]> {
  if (eventIds.length === 0 || personIds.length === 0) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT ON (event_id, person_id) id FROM public.event_registrations
    WHERE event_id = ANY (${uuidArray(eventIds)}::uuid[])
      AND person_id = ANY (${uuidArray(personIds)}::uuid[])
    ORDER BY event_id, person_id,
      (status IN ('confirmed', 'waitlisted', 'offered')) DESC, updated_at DESC`);
  if (rows.length === 0) return [];
  return tx
    .select()
    .from(eventRegistrations)
    .where(
      inArray(
        eventRegistrations.id,
        rows.map((r) => r.id),
      ),
    );
}

/** The place in the queue (1 = next) of waiting registrations, by registration ID. */
export async function positionsOf(
  tx: Tx,
  eventIds: readonly string[],
): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; position: number }>(sql`
    SELECT id, row_number() OVER (PARTITION BY event_id ORDER BY queued_at, id)::int AS position
    FROM public.event_registrations
    WHERE event_id = ANY (${uuidArray(eventIds)}::uuid[]) AND status = 'waitlisted'`);
  return new Map(rows.map((r) => [r.id, r.position]));
}

/**
 * The organisers' list: open registrations first (confirmed, given name
 * first; offered and the queue in queue order), then the others, keyset by
 * registration ID within that order.
 */
export async function registrationPage(
  tx: Tx,
  input: {
    eventId: string;
    status: RegistrationStatus | null;
    cursor: string | null;
    limit: number;
  },
): Promise<RegistrationRow[]> {
  const rank = sql`CASE r.status WHEN 'confirmed' THEN 0 WHEN 'offered' THEN 1 WHEN 'waitlisted' THEN 2 ELSE 3 END`;
  const name = (r: string) =>
    sql`CASE WHEN ${sql.raw(r)}.status = 'confirmed' THEN ${givenNameSortKey(sql.raw(`${r}.person_id`))} ELSE '' END`;
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT r.id FROM public.event_registrations r
    WHERE r.event_id = ${input.eventId}
      ${input.status ? sql`AND r.status = ${input.status}` : sql``}
      ${
        input.cursor
          ? sql`AND (${rank}, ${name("r")}, r.queued_at, r.id) > (
              SELECT CASE c.status WHEN 'confirmed' THEN 0 WHEN 'offered' THEN 1 WHEN 'waitlisted' THEN 2 ELSE 3 END,
                ${name("c")}, c.queued_at, c.id
              FROM public.event_registrations c WHERE c.id = ${input.cursor})`
          : sql``
      }
    ORDER BY ${rank}, ${name("r")}, r.queued_at, r.id
    LIMIT ${input.limit}`);
  if (rows.length === 0) return [];
  const found = await tx
    .select()
    .from(eventRegistrations)
    .where(
      inArray(
        eventRegistrations.id,
        rows.map((r) => r.id),
      ),
    );
  const byId = new Map(found.map((r) => [r.id, r]));
  return rows.flatMap((r) => byId.get(r.id) ?? []);
}

/** Every registration of an event in list order (the export; at most the capacity's size). */
export async function allRegistrations(tx: Tx, eventId: string): Promise<RegistrationRow[]> {
  return registrationPage(tx, { eventId, status: null, cursor: null, limit: 100_000 });
}

/** Offers past their time, across clubs (a system job: policy system_read). */
export async function dueOffers(tx: Tx, limit: number): Promise<{ id: string; clubId: string }[]> {
  const { rows } = await tx.execute<{ id: string; club_id: string }>(sql`
    SELECT id, club_id FROM public.event_registrations
    WHERE status = 'offered' AND offer_expires_at <= now()
    ORDER BY offer_expires_at
    LIMIT ${limit}`);
  return rows.map((r) => ({ id: r.id, clubId: r.club_id }));
}

export async function findRegistration(tx: Tx, id: string): Promise<RegistrationRow | null> {
  const [row] = await tx.select().from(eventRegistrations).where(eq(eventRegistrations.id, id));
  return row ?? null;
}
