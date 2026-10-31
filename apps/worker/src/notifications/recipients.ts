// SPDX-License-Identifier: AGPL-3.0-only
// Who hears about what (P1.7): the facts of an activity or event as the
// notices need them, the people they concern, and those notified for them.
// One statement per question, never one per person (no N+1). Reads in the
// worker's system context; club-owned rows after setting the club.

import { sql, type Tx } from "@clubadmin/db";
import type { GuardianshipRight } from "@clubadmin/shared";

import { uuidArray } from "./fanout.ts";

/** Club-owned rows are read in the club (tenant row-level security). */
export const useClub = (tx: Tx, clubId: string) =>
  tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);

/** Rights a linked person needs per kind of notice (decision 4); full guardians hold them all. */
export const RIGHTS = {
  schedule: ["receive_messages", "view_schedule"],
  answer: ["receive_messages", "sign_up"],
  events: ["receive_messages", "sign_up"],
  messages: ["receive_messages"],
} as const satisfies Record<string, readonly GuardianshipRight[]>;

/**
 * The people themselves and their guardians holding `rights`: recipient →
 * the wards it is about (empty for the person themselves). Recipients
 * without an account are dropped later (createNotices).
 */
export async function withGuardians(
  tx: Tx,
  personIds: readonly string[],
  rights: readonly GuardianshipRight[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (personIds.length === 0) return result;
  for (const id of personIds) result.set(id, []);
  const { rows } = await tx.execute<{ guardian_person_id: string; ward_person_id: string }>(sql`
    SELECT g.guardian_person_id, g.ward_person_id FROM public.guardianships g
    WHERE g.ward_person_id = ANY (${uuidArray(personIds)}::uuid[])
      AND g.status = 'active' AND g.valid_to IS NULL
      AND g.rights @> ${`{${rights.join(",")}}`}::text[]`);
  for (const r of rows) {
    result.set(r.guardian_person_id, [
      ...(result.get(r.guardian_person_id) ?? []),
      r.ward_person_id,
    ]);
  }
  return result;
}

export interface ActivityFacts {
  id: string;
  clubId: string;
  seriesId: string | null;
  title: string;
  status: string;
  startsAt: Date;
  sequence: number;
  responseMode: string;
  respondBy: Date | null;
  place: string | null;
  group: string | null;
  timeZone: string;
}

export async function activityFacts(
  tx: Tx,
  clubId: string,
  activityId: string,
): Promise<ActivityFacts | null> {
  await useClub(tx, clubId);
  const { rows } = await tx.execute<{
    id: string;
    club_id: string;
    series_id: string | null;
    title: string;
    status: string;
    starts_at: string;
    sequence: number;
    response_mode: string;
    respond_by: string | null;
    place: string | null;
    group_name: string | null;
    time_zone: string;
  }>(sql`
    SELECT a.id, a.club_id, a.series_id, a.title, a.status, a.starts_at, a.sequence,
      a.response_mode, a.respond_by, coalesce(l.name, a.location_text) AS place, c.time_zone,
      (SELECT g.name FROM public.activity_groups ag JOIN public.groups g ON g.id = ag.group_id
       WHERE ag.activity_id = a.id ORDER BY g.name LIMIT 1) AS group_name
    FROM public.activities a
    JOIN public.clubs c ON c.id = a.club_id
    LEFT JOIN public.locations l ON l.club_id = a.club_id AND l.id = a.location_id
    WHERE a.id = ${activityId}`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    clubId: r.club_id,
    seriesId: r.series_id,
    title: r.title,
    status: r.status,
    startsAt: new Date(r.starts_at),
    sequence: r.sequence,
    responseMode: r.response_mode,
    respondBy: r.respond_by ? new Date(r.respond_by) : null,
    place: r.place,
    group: r.group_name,
    timeZone: r.time_zone,
  };
}

/** Params of a notice about an activity (no names). */
export const activityParams = (a: ActivityFacts) => ({
  title: a.title,
  startsAt: a.startsAt.toISOString(),
  timeZone: a.timeZone,
  group: a.group,
  place: a.place,
  ...(a.respondBy ? { deadline: a.respondBy.toISOString() } : {}),
});

/** The roster's participants (ADR 0035/0036): members on its start, with a call-up those called up. */
export async function participants(tx: Tx, activityId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT gm.person_id FROM public.activities a
    JOIN public.activity_groups ag ON ag.activity_id = a.id
    JOIN public.group_memberships gm ON gm.club_id = ag.club_id AND gm.group_id = ag.group_id
      AND gm.function = 'member' AND gm.valid_from <= a.starts_at
      AND (gm.valid_to IS NULL OR gm.valid_to > a.starts_at)
    WHERE a.id = ${activityId}
      AND (NOT a.invitees_only OR EXISTS (
        SELECT 1 FROM public.activity_invitees i
        WHERE i.activity_id = a.id AND i.person_id = gm.person_id))`);
  return rows.map((r) => r.person_id);
}

/**
 * Those who see an activity's answers (`activity.responses.read`): club
 * managers, owners of its groups or their ancestors, and the groups'
 * leaders (head and assistant coaches, team managers, other leaders).
 */
export async function leaders(tx: Tx, clubId: string, activityId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    WITH RECURSIVE g AS (
      SELECT ag.group_id AS id FROM public.activity_groups ag WHERE ag.activity_id = ${activityId}
      UNION
      SELECT p.parent_group_id FROM public.groups p JOIN g ON p.id = g.id
      WHERE p.parent_group_id IS NOT NULL
    )
    SELECT person_id FROM public.club_role_assignments
    WHERE club_id = ${clubId} AND role = 'club_manager' AND valid_to IS NULL
    UNION
    SELECT o.person_id FROM public.group_owners o JOIN g ON o.group_id = g.id
    WHERE o.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM public.group_memberships gm
    JOIN public.activity_groups ag ON ag.group_id = gm.group_id AND ag.activity_id = ${activityId}
    WHERE gm.valid_to IS NULL
      AND gm.function IN ('head_coach', 'assistant_coach', 'team_manager', 'other_leader')`);
  return rows.map((r) => r.person_id);
}

/** Members of groups (now). */
export async function groupMembers(tx: Tx, groupIds: readonly string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT person_id FROM public.group_memberships
    WHERE group_id = ANY (${uuidArray(groupIds)}::uuid[]) AND function = 'member' AND valid_to IS NULL`);
  return rows.map((r) => r.person_id);
}

export interface EventFacts {
  id: string;
  clubId: string;
  title: string;
  status: string;
  audience: string;
  startsAt: Date;
  closesAt: Date;
  timeZone: string;
}

export async function eventFacts(
  tx: Tx,
  clubId: string,
  eventId: string,
): Promise<EventFacts | null> {
  await useClub(tx, clubId);
  const { rows } = await tx.execute<{
    id: string;
    club_id: string;
    title: string;
    status: string;
    audience: string;
    starts_at: string;
    registration_closes_at: string;
    time_zone: string;
  }>(sql`
    SELECT e.id, e.club_id, e.title, e.status, e.audience, e.starts_at, e.registration_closes_at,
      c.time_zone
    FROM public.events e JOIN public.clubs c ON c.id = e.club_id WHERE e.id = ${eventId}`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    clubId: r.club_id,
    title: r.title,
    status: r.status,
    audience: r.audience,
    startsAt: new Date(r.starts_at),
    closesAt: new Date(r.registration_closes_at),
    timeZone: r.time_zone,
  };
}

export const eventParams = (e: EventFacts) => ({
  title: e.title,
  startsAt: e.startsAt.toISOString(),
  timeZone: e.timeZone,
  deadline: e.closesAt.toISOString(),
});

/** The audience of an event: its groups' members, or the club's active members. */
export async function eventAudience(tx: Tx, event: EventFacts): Promise<string[]> {
  if (event.audience === "club") {
    const { rows } = await tx.execute<{ person_id: string }>(sql`
      SELECT DISTINCT person_id FROM public.club_memberships
      WHERE club_id = ${event.clubId} AND status = 'active' AND valid_to IS NULL`);
    return rows.map((r) => r.person_id);
  }
  const { rows } = await tx.execute<{ group_id: string }>(sql`
    SELECT group_id FROM public.event_groups WHERE event_id = ${event.id}`);
  return groupMembers(
    tx,
    rows.map((r) => r.group_id),
  );
}

/** People with an open registration (confirmed, waitlisted, offered). */
export async function registrants(tx: Tx, eventId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT person_id FROM public.event_registrations
    WHERE event_id = ${eventId} AND status IN ('confirmed', 'waitlisted', 'offered')`);
  return rows.map((r) => r.person_id);
}
