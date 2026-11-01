// SPDX-License-Identifier: AGPL-3.0-only
// Statements of "download my data" and erasure (P1.8b): data_exports and
// erasure_requests (global tables, row-level security per migration 0021),
// and the cross-club facts app.erasure_assignments and app.ward_logins
// return for the caller and their wards. IDs only.

import { sql, type Tx } from "@clubadmin/db";
import type { DataExportStatus, ErasureKind, ErasureStatus } from "@clubadmin/shared";

/** A uuid[] parameter (IDs only, validated where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

export type DataExportRow = {
  id: string;
  subjectPersonId: string;
  requestedByPersonId: string;
  status: DataExportStatus;
  objectKey: string | null;
  sizeBytes: number | null;
  locale: string;
  expiresAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
};

const exportColumns = sql`
  id, subject_person_id AS "subjectPersonId", requested_by_person_id AS "requestedByPersonId",
  status, object_key AS "objectKey", size_bytes::float8 AS "sizeBytes", locale,
  expires_at AS "expiresAt", error_code AS "errorCode", created_at AS "createdAt"`;

const toExport = (r: DataExportRow): DataExportRow => ({
  ...r,
  expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
  createdAt: new Date(r.createdAt),
});

/** Requests the requester made in the last 24 hours (data_exports_requester_idx). */
export async function countRecentExports(tx: Tx, requesterId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.data_exports
    WHERE requested_by_person_id = ${requesterId} AND created_at > now() - interval '24 hours'`);
  return rows[0]?.n ?? 0;
}

export async function insertExport(
  tx: Tx,
  input: { subjectPersonId: string; requestedByPersonId: string; locale: string },
): Promise<DataExportRow> {
  const { rows } = await tx.execute<DataExportRow>(sql`
    INSERT INTO public.data_exports (subject_person_id, requested_by_person_id, locale)
    VALUES (${input.subjectPersonId}, ${input.requestedByPersonId}, ${input.locale})
    RETURNING ${exportColumns}`);
  return toExport(rows[0]!);
}

/** The requester's exports, newest first, after the cursor (keyset). */
export async function listExports(
  tx: Tx,
  requesterId: string,
  options: { after: string | null; limit: number },
): Promise<DataExportRow[]> {
  const after = options.after
    ? sql`AND (created_at, id) < (SELECT created_at, id FROM public.data_exports
            WHERE id = ${options.after} AND requested_by_person_id = ${requesterId})`
    : sql``;
  const { rows } = await tx.execute<DataExportRow>(sql`
    SELECT ${exportColumns} FROM public.data_exports
    WHERE requested_by_person_id = ${requesterId} ${after}
    ORDER BY created_at DESC, id DESC LIMIT ${options.limit}`);
  return rows.map(toExport);
}

export async function exportExists(tx: Tx, id: string, requesterId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM public.data_exports
    WHERE id = ${id} AND requested_by_person_id = ${requesterId}`);
  return rows.length > 0;
}

export async function findExport(tx: Tx, id: string): Promise<DataExportRow | null> {
  const { rows } = await tx.execute<DataExportRow>(
    sql`SELECT ${exportColumns} FROM public.data_exports WHERE id = ${id}`,
  );
  return rows[0] ? toExport(rows[0]) : null;
}

export type ErasureRequestRow = {
  id: string;
  personId: string;
  requestedByPersonId: string;
  kind: ErasureKind;
  status: ErasureStatus;
  scheduledFor: Date;
  includeWardIds: string[];
  pendingIdpSubject: string | null;
  attempts: number;
};

const erasureColumns = sql`
  id, person_id AS "personId", requested_by_person_id AS "requestedByPersonId", kind, status,
  scheduled_for AS "scheduledFor", include_ward_ids AS "includeWardIds",
  pending_idp_subject AS "pendingIdpSubject", attempts`;

const toErasure = (r: ErasureRequestRow): ErasureRequestRow => ({
  ...r,
  scheduledFor: new Date(r.scheduledFor),
});

/** Open (scheduled or running) requests for any of the people (erasure_requests_open_unique). */
export async function openErasures(
  tx: Tx,
  personIds: readonly string[],
): Promise<ErasureRequestRow[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<ErasureRequestRow>(sql`
    SELECT ${erasureColumns} FROM public.erasure_requests
    WHERE person_id = ANY (${uuidArray(personIds)}::uuid[]) AND status IN ('scheduled', 'running')`);
  return rows.map(toErasure);
}

/**
 * Whether one of the people is to be erased with someone else's account
 * deletion (the ward of a parent deleting their account).
 */
export async function includedInErasure(
  tx: Tx,
  personId: string,
): Promise<ErasureRequestRow | null> {
  const { rows } = await tx.execute<ErasureRequestRow>(sql`
    SELECT ${erasureColumns} FROM public.erasure_requests
    WHERE include_ward_ids @> ARRAY[${personId}::uuid] AND status IN ('scheduled', 'running')
    LIMIT 1`);
  return rows[0] ? toErasure(rows[0]) : null;
}

export async function insertErasure(
  tx: Tx,
  input: {
    personId: string;
    requestedByPersonId: string;
    kind: ErasureKind;
    scheduledFor: Date;
    includeWardIds: readonly string[];
  },
): Promise<ErasureRequestRow | null> {
  const { rows } = await tx.execute<ErasureRequestRow>(sql`
    INSERT INTO public.erasure_requests
      (person_id, requested_by_person_id, kind, scheduled_for, include_ward_ids)
    VALUES (${input.personId}, ${input.requestedByPersonId}, ${input.kind},
      ${input.scheduledFor.toISOString()}, ${uuidArray(input.includeWardIds)}::uuid[])
    ON CONFLICT DO NOTHING
    RETURNING ${erasureColumns}`);
  return rows[0] ? toErasure(rows[0]) : null;
}

/** Cancels a scheduled request; false if it is no longer scheduled. */
export async function cancelErasure(tx: Tx, id: string, byPersonId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.erasure_requests
    SET status = 'cancelled', cancelled_by_person_id = ${byPersonId}, cancelled_at = now()
    WHERE id = ${id} AND status = 'scheduled'
    RETURNING id`);
  return rows.length > 0;
}

export type AssignmentFact = {
  personId: string;
  clubId: string;
  clubName: string;
  kind: "membership" | "role" | "group_function" | "group_owner";
  assignmentId: string;
  role: string | null;
  groupId: string | null;
  groupName: string | null;
  groupFunction: string | null;
  lastManager: boolean;
};

/** Memberships, roles, leader functions and ownerships of the people in every club. */
export async function assignmentFacts(
  tx: Tx,
  personIds: readonly string[],
): Promise<AssignmentFact[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<AssignmentFact>(sql`
    SELECT person_id AS "personId", club_id AS "clubId", club_name AS "clubName", kind,
      assignment_id AS "assignmentId", role, group_id AS "groupId", group_name AS "groupName",
      group_function AS "groupFunction", last_manager AS "lastManager"
    FROM app.erasure_assignments(${uuidArray(personIds)}::uuid[])`);
  return rows;
}

/**
 * The same facts without the caller filter, for the erasure job's check as
 * clubadmin_retention (which sees every row; the function above runs as its
 * owner, which sees only the caller's own relationships).
 */
export async function assignmentFactsAsRetention(
  tx: Tx,
  personIds: readonly string[],
): Promise<AssignmentFact[]> {
  if (personIds.length === 0) return [];
  const people = sql`${uuidArray(personIds)}::uuid[]`;
  const { rows } = await tx.execute<AssignmentFact>(sql`
    SELECT m.person_id AS "personId", m.club_id AS "clubId", c.name AS "clubName",
      'membership' AS kind, m.id AS "assignmentId", NULL AS role, NULL::uuid AS "groupId",
      NULL AS "groupName", NULL AS "groupFunction", false AS "lastManager"
    FROM public.club_memberships m JOIN public.clubs c ON c.id = m.club_id
    WHERE m.person_id = ANY (${people}) AND m.valid_to IS NULL
    UNION ALL
    SELECT r.person_id, r.club_id, c.name, 'role', r.id, r.role, NULL, NULL, NULL,
      r.role = 'club_manager' AND NOT EXISTS (
        SELECT 1 FROM public.club_role_assignments o
        WHERE o.club_id = r.club_id AND o.role = 'club_manager' AND o.valid_to IS NULL
          AND o.person_id <> r.person_id)
    FROM public.club_role_assignments r JOIN public.clubs c ON c.id = r.club_id
    WHERE r.person_id = ANY (${people}) AND r.valid_to IS NULL
    UNION ALL
    SELECT g.person_id, g.club_id, c.name, 'group_function', g.id, NULL, g.group_id, gr.name,
      g.function, false
    FROM public.group_memberships g
    JOIN public.clubs c ON c.id = g.club_id JOIN public.groups gr ON gr.id = g.group_id
    WHERE g.person_id = ANY (${people}) AND g.valid_to IS NULL AND g.function <> 'member'
    UNION ALL
    SELECT o.person_id, o.club_id, c.name, 'group_owner', o.id, NULL, o.group_id, gr.name, NULL,
      false
    FROM public.group_owners o
    JOIN public.clubs c ON c.id = o.club_id JOIN public.groups gr ON gr.id = o.group_id
    WHERE o.person_id = ANY (${people}) AND o.valid_to IS NULL`);
  return rows;
}

export type WardLogin = {
  wardPersonId: string;
  wardHasLogin: boolean;
  otherGuardianIds: string[];
  otherGuardiansWithLogin: number;
};

/** The guardian's wards (full guardianship) and who else can log in for them. */
export async function wardLogins(tx: Tx, guardianId: string): Promise<WardLogin[]> {
  const { rows } = await tx.execute<WardLogin>(sql`
    SELECT ward_person_id AS "wardPersonId", ward_has_login AS "wardHasLogin",
      other_guardian_ids AS "otherGuardianIds",
      other_guardians_with_login AS "otherGuardiansWithLogin"
    FROM app.ward_logins(${guardianId})`);
  return rows;
}

/** The person's account language (null without an account). */
export async function accountLocale(tx: Tx, personId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ locale: string | null }>(
    sql`SELECT locale FROM public.accounts WHERE person_id = ${personId}`,
  );
  return rows[0]?.locale ?? null;
}
