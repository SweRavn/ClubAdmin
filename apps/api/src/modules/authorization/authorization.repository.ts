// SPDX-License-Identifier: AGPL-3.0-only
// Read-only queries of the authorization module. ADR 0006: relationships are
// read straight from the core tables (the only module that reads other
// modules' tables), in one query, through the own-relationships policies
// (ADR 0023). Resource loaders read the minimal scope a policy needs.

import { sql, type Tx } from "@clubadmin/db";
import type { GroupFunction, MembershipStatus, MembershipType } from "@clubadmin/shared";

import type { RelationshipSet } from "./relationship-set.ts";

/** A uuid[] parameter (the IDs come from our own data or validated input). */
export const uuidArray = (ids: readonly string[]) =>
  sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

/**
 * The person's relationship set in one statement. Runs as the person
 * (withActor): RLS exposes exactly their own rows and their wards'.
 */
export async function loadRelationshipSet(tx: Tx, personId: string): Promise<RelationshipSet> {
  const { rows } = await tx.execute<{ set: Omit<RelationshipSet, "personId"> }>(
    relationshipSetQuery(personId),
  );
  return { personId, ...rows[0]!.set };
}

/** The statement of loadRelationshipSet (each part uses a person_id index; query-plans test). */
export function relationshipSetQuery(personId: string) {
  return sql`
    WITH wards AS (
      SELECT g.ward_person_id AS person_id, g.kind, g.rights FROM public.guardianships g
      WHERE g.guardian_person_id = ${personId} AND g.status = 'active' AND g.valid_to IS NULL
    )
    SELECT jsonb_build_object(
      'operator', EXISTS (
        SELECT 1 FROM public.platform_operators o WHERE o.person_id = ${personId} AND o.valid_to IS NULL
      ),
      'memberships', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', m.club_id, 'status', m.status, 'membershipType', m.membership_type))
        FROM public.club_memberships m WHERE m.person_id = ${personId} AND m.valid_to IS NULL
      ), '[]'),
      'roles', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', r.club_id, 'role', r.role))
        FROM public.club_role_assignments r WHERE r.person_id = ${personId} AND r.valid_to IS NULL
      ), '[]'),
      'groups', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', gm.club_id, 'groupId', gm.group_id, 'function', gm.function))
        FROM public.group_memberships gm WHERE gm.person_id = ${personId} AND gm.valid_to IS NULL
      ), '[]'),
      'ownedGroups', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', o.club_id, 'groupId', o.group_id))
        FROM public.group_owners o WHERE o.person_id = ${personId} AND o.valid_to IS NULL
      ), '[]'),
      'employments', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', e.club_id, 'startsOn', e.starts_on, 'endsOn', e.ends_on))
        FROM public.employments e WHERE e.person_id = ${personId} AND (e.ends_on IS NULL OR e.ends_on >= current_date)
      ), '[]'),
      'supportGrants', coalesce((
        SELECT jsonb_agg(jsonb_build_object('clubId', s.club_id, 'expiresAt', s.expires_at))
        FROM public.support_access_grants s
        WHERE s.operator_person_id = ${personId} AND s.revoked_at IS NULL AND s.expires_at > now()
      ), '[]'),
      'wards', coalesce((
        SELECT jsonb_agg(jsonb_build_object('personId', w.person_id, 'kind', w.kind, 'rights', w.rights)) FROM wards w
      ), '[]'),
      'guardians', coalesce((
        SELECT jsonb_agg(jsonb_build_object('personId', g.guardian_person_id, 'kind', g.kind))
        FROM public.guardianships g
        WHERE g.ward_person_id = ${personId} AND g.status = 'active' AND g.valid_to IS NULL
      ), '[]'),
      'wardMemberships', coalesce((
        SELECT jsonb_agg(jsonb_build_object('personId', m.person_id, 'clubId', m.club_id, 'status', m.status, 'membershipType', m.membership_type))
        FROM public.club_memberships m JOIN wards w ON w.person_id = m.person_id WHERE m.valid_to IS NULL
      ), '[]'),
      'wardGroups', coalesce((
        SELECT jsonb_agg(jsonb_build_object('personId', gm.person_id, 'clubId', gm.club_id, 'groupId', gm.group_id, 'function', gm.function))
        FROM public.group_memberships gm JOIN wards w ON w.person_id = gm.person_id WHERE gm.valid_to IS NULL
      ), '[]')
    ) AS set`;
}

export interface GroupScopeRow {
  clubId: string;
  /** Ancestors, nearest first. */
  ancestorIds: string[];
  archived: boolean;
  ownersCanAppointCoOwners: boolean;
}

/**
 * A group's club and ancestor chain, as visible to the actor (groups of clubs
 * the actor has no relationship with are invisible: null).
 */
export async function loadGroupScope(tx: Tx, groupId: string): Promise<GroupScopeRow | null> {
  const { rows } = await tx.execute<{
    club_id: string;
    ancestor_ids: string[];
    archived: boolean;
    owners_can_appoint: boolean | null;
  }>(sql`
    WITH RECURSIVE up AS (
      SELECT g.id, g.club_id, g.parent_group_id, g.archived_at, 0 AS depth FROM public.groups g WHERE g.id = ${groupId}
      UNION ALL
      SELECT p.id, p.club_id, p.parent_group_id, p.archived_at, up.depth + 1
      FROM up JOIN public.groups p ON p.id = up.parent_group_id
    )
    SELECT s.club_id, s.archived_at IS NOT NULL AS archived,
      coalesce((SELECT array_agg(a.id ORDER BY a.depth) FROM up a WHERE a.depth > 0), '{}') AS ancestor_ids,
      (SELECT c.owners_can_appoint_co_owners FROM public.clubs c WHERE c.id = s.club_id) AS owners_can_appoint
    FROM up s WHERE s.depth = 0`);
  const row = rows[0];
  if (!row) return null;
  return {
    clubId: row.club_id,
    ancestorIds: row.ancestor_ids,
    archived: row.archived,
    ownersCanAppointCoOwners: row.owners_can_appoint === true,
  };
}

export interface PersonGroupRow {
  personId: string;
  groupId: string;
  function: GroupFunction;
  ancestorIds: string[];
}

/** Open group memberships of the people in the transaction's club, with each group's ancestors. */
export async function loadGroupsOfPeople(
  tx: Tx,
  clubId: string,
  personIds: readonly string[],
): Promise<PersonGroupRow[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{
    person_id: string;
    group_id: string;
    function: GroupFunction;
    ancestor_ids: string[];
  }>(sql`
    WITH RECURSIVE m AS (
      SELECT gm.person_id, gm.group_id, gm.function FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.valid_to IS NULL AND gm.person_id = ANY (${uuidArray(personIds)})
    ), up AS (
      SELECT g.id AS start_id, g.parent_group_id AS next_id FROM public.groups g
      WHERE g.id IN (SELECT group_id FROM m)
      UNION
      SELECT up.start_id, p.parent_group_id FROM up JOIN public.groups p ON p.id = up.next_id
    )
    SELECT m.person_id, m.group_id, m.function,
      coalesce((SELECT array_agg(up.next_id) FROM up WHERE up.start_id = m.group_id AND up.next_id IS NOT NULL), '{}') AS ancestor_ids
    FROM m`);
  return rows.map((r) => ({
    personId: r.person_id,
    groupId: r.group_id,
    function: r.function,
    ancestorIds: r.ancestor_ids,
  }));
}

export interface PersonInClubRow {
  memberNumber: number;
  sharedFields: string[];
  protected: boolean;
  membership: { status: MembershipStatus; membershipType: MembershipType } | null;
}

/** The person's profile in the transaction's club (null if they never were a member). */
export async function loadPersonInClub(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<PersonInClubRow | null> {
  const { rows } = await tx.execute<{
    member_number: number;
    shared_fields: string[];
    protected: boolean;
    membership: PersonInClubRow["membership"];
  }>(sql`
    SELECT cp.member_number, cp.shared_fields,
      cp.protected_identity_club OR coalesce(p.protected_identity, false) AS protected,
      (SELECT jsonb_build_object('status', m.status, 'membershipType', m.membership_type)
       FROM public.club_memberships m
       WHERE m.club_id = cp.club_id AND m.person_id = cp.person_id AND m.valid_to IS NULL) AS membership
    FROM public.club_profiles cp
    LEFT JOIN public.people p ON p.id = cp.person_id
    WHERE cp.club_id = ${clubId} AND cp.person_id = ${personId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    memberNumber: row.member_number,
    sharedFields: row.shared_fields,
    protected: row.protected,
    membership: row.membership,
  };
}

/**
 * People with protected identity in the club (ADR 0022): the club flag, and
 * the global flag of members (anyone with a profile), guardians of members
 * and join applicants: everyone the club can reach.
 */
export async function loadProtectedSet(tx: Tx, clubId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(protectedSetQuery(clubId));
  return rows.map((r) => r.id);
}

/** The statement of loadProtectedSet (partial indexes on the protected flags). */
export function protectedSetQuery(clubId: string) {
  return sql`
    SELECT cp.person_id AS id FROM public.club_profiles cp
    WHERE cp.club_id = ${clubId} AND cp.protected_identity_club
    UNION
    SELECT p.id FROM public.people p
    WHERE p.protected_identity AND (
      EXISTS (SELECT 1 FROM public.club_profiles cp WHERE cp.club_id = ${clubId} AND cp.person_id = p.id)
      OR EXISTS (
        SELECT 1 FROM public.guardianships g
        JOIN public.club_profiles cp ON cp.club_id = ${clubId} AND cp.person_id = g.ward_person_id
        WHERE g.guardian_person_id = p.id AND g.status = 'active' AND g.valid_to IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.join_requests jr
        WHERE jr.club_id = ${clubId} AND p.id IN (jr.person_id, jr.requested_by_person_id)
      )
    )`;
}

export async function loadHandoverScope(
  tx: Tx,
  handoverId: string,
): Promise<{ clubId: string; fromPersonId: string; toPersonId: string } | null> {
  const { rows } = await tx.execute<{
    club_id: string;
    from_person_id: string;
    to_person_id: string;
  }>(
    sql`SELECT club_id, from_person_id, to_person_id FROM public.club_manager_handovers WHERE id = ${handoverId}`,
  );
  const row = rows[0];
  return row
    ? { clubId: row.club_id, fromPersonId: row.from_person_id, toPersonId: row.to_person_id }
    : null;
}

/**
 * The person a family resource is about, as visible to the actor (P1.3): the
 * ward of a guardianship or guardian invitation, the kept person of a merge.
 */
export async function loadFamilyResourcePerson(
  tx: Tx,
  kind: "guardianship" | "invitation" | "merge",
  id: string,
): Promise<string | null> {
  const query =
    kind === "guardianship"
      ? sql`SELECT ward_person_id AS person_id FROM public.guardianships WHERE id = ${id}`
      : kind === "invitation"
        ? sql`SELECT ward_person_id AS person_id FROM public.guardian_invitations WHERE id = ${id}`
        : sql`SELECT kept_person_id AS person_id FROM public.people_merges WHERE id = ${id}`;
  const { rows } = await tx.execute<{ person_id: string }>(query);
  return rows[0]?.person_id ?? null;
}

/** The club and groups of an activity or series (app.activity_scope; insider_read outside a club). */
export async function loadEventScope(
  tx: Tx,
  eventId: string,
): Promise<{
  clubId: string;
  audience: "groups" | "club";
  status: string;
  groupIds: string[];
} | null> {
  const { rows } = await tx.execute<{
    club_id: string;
    audience: "groups" | "club";
    status: string;
    group_ids: string[];
  }>(sql`SELECT club_id, audience, status, group_ids FROM app.event_scope(${eventId}::uuid)`);
  const row = rows[0];
  return row
    ? { clubId: row.club_id, audience: row.audience, status: row.status, groupIds: row.group_ids }
    : null;
}

export async function loadActivityScope(
  tx: Tx,
  ids: { activityId?: string; seriesId?: string },
): Promise<{ clubId: string; groupIds: string[] } | null> {
  const { rows } = await tx.execute<{ club_id: string; group_ids: string[] }>(sql`
    SELECT club_id, group_ids FROM app.activity_scope(${ids.activityId ?? null}::uuid, ${ids.seriesId ?? null}::uuid)`);
  const row = rows[0];
  return row ? { clubId: row.club_id, groupIds: row.group_ids } : null;
}
