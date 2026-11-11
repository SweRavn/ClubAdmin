// SPDX-License-Identifier: AGPL-3.0-only
// The profile view log and the protection state (P1.12, ADR 0022). Rows
// carry IDs only; names come from PersonPresenter.

import { sql, type Tx } from "@clubadmin/db";
import type {
  ClubProfileViewsQuery,
  ProfileViewerKind,
  ProfileViewerRole,
  ProfileViewLoggingMode,
  ProfileViewSurface,
} from "@clubadmin/shared";

export interface ViewRow {
  id: string;
  clubId: string | null;
  viewedPersonId: string | null;
  viewerPersonId: string | null;
  onBehalfOfPersonId: string | null;
  viewerKind: ProfileViewerKind;
  surface: ProfileViewSurface;
  protected: boolean;
  day: string;
  firstViewedAt: Date;
  lastViewedAt: Date;
  viewCount: number;
  anonymized: boolean;
}

type DbViewRow = {
  id: string;
  club_id: string | null;
  viewed_person_id?: string | null;
  viewer_person_id: string | null;
  on_behalf_of_person_id: string | null;
  viewer_kind: ProfileViewerKind;
  surface: ProfileViewSurface;
  protected: boolean;
  day: string;
  first_viewed_at: string | Date;
  last_viewed_at: string | Date;
  view_count: number;
  anonymized: boolean;
};

const toRow = (r: DbViewRow, viewed: string | null = r.viewed_person_id ?? null): ViewRow => ({
  id: r.id,
  clubId: r.club_id,
  viewedPersonId: viewed,
  viewerPersonId: r.viewer_person_id,
  onBehalfOfPersonId: r.on_behalf_of_person_id,
  viewerKind: r.viewer_kind,
  surface: r.surface,
  protected: r.protected,
  day: typeof r.day === "string" ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
  firstViewedAt: new Date(r.first_viewed_at),
  lastViewedAt: new Date(r.last_viewed_at),
  viewCount: r.view_count,
  anonymized: r.anonymized,
});

/** One person's log across clubs (app.profile_view_log: the person and full guardians only). */
export async function personLog(
  tx: Tx,
  personId: string,
  cursor: string | null,
  limit: number,
): Promise<ViewRow[]> {
  const { rows } = await tx.execute<DbViewRow>(
    sql`SELECT * FROM app.profile_view_log(${personId}::uuid, ${cursor}::uuid, ${limit})`,
  );
  return rows.map((r) => toRow(r, personId));
}

/** The statement of clubLog (query-plans test): newest first on profile_views_club_idx. */
export function clubLogQuery(clubId: string, query: ClubProfileViewsQuery, limit: number) {
  return sql`
    WITH anchor AS (
      SELECT v.last_viewed_at, v.id FROM public.profile_views v
      WHERE v.club_id = ${clubId} AND v.id = ${query.cursor ?? null}::uuid
    )
    SELECT v.id, v.club_id, v.viewed_person_id, v.viewer_person_id, v.on_behalf_of_person_id,
      v.viewer_kind, v.surface, v.protected, v.day, v.first_viewed_at, v.last_viewed_at,
      v.view_count, v.anonymized_at IS NOT NULL AS anonymized
    FROM public.profile_views v
    WHERE v.club_id = ${clubId}
      ${query.personId ? sql`AND v.viewed_person_id = ${query.personId}` : sql``}
      ${query.viewerId ? sql`AND v.viewer_person_id = ${query.viewerId}` : sql``}
      ${query.protected === "only" ? sql`AND v.protected` : sql``}
      AND (${query.cursor ?? null}::uuid IS NULL
        OR (v.last_viewed_at, v.id) < (SELECT a.last_viewed_at, a.id FROM anchor a))
    ORDER BY v.last_viewed_at DESC, v.id DESC
    LIMIT ${limit}`;
}

/** The club's log (tenant RLS: club managers, checked by the policy). */
export async function clubLog(
  tx: Tx,
  clubId: string,
  query: ClubProfileViewsQuery,
  limit: number,
): Promise<ViewRow[]> {
  const { rows } = await tx.execute<DbViewRow>(clubLogQuery(clubId, query, limit));
  return rows.map((r) => toRow(r));
}

export interface ViewContext {
  clubNames: Map<string, string>;
  /** `${clubId}:${viewerId}:${viewedId}` → role. */
  roles: Map<string, ProfileViewerRole>;
}

export const roleKey = (clubId: string | null, viewer: string, viewed: string | null) =>
  `${clubId ?? ""}:${viewer}:${viewed ?? ""}`;

/* eslint-disable clubadmin/no-role-names -- labels a viewer in the access log, decides nothing */
/** Which of a viewer's roles names them in the access log. */
const ROLE_LABEL_ORDER = [
  "club_manager",
  "registrar",
  "chair",
  "vice_chair",
  "treasurer",
  "secretary",
  "board_member",
  "deputy_board_member",
  "auditor",
  "nomination_committee",
  "safeguarding_officer",
  "communications",
] as const;
/* eslint-enable clubadmin/no-role-names */

/**
 * Club names and the relationship that allows each viewer to open the
 * profile now (read time): a club role, a leader function, guardian of the
 * person, or member. One statement for the page (system read: the reader
 * may not see the viewer's roles).
 */
export async function viewContext(tx: Tx, rows: readonly ViewRow[]): Promise<ViewContext> {
  const clubIds = [...new Set(rows.flatMap((r) => (r.clubId ? [r.clubId] : [])))];
  const pairs = rows.flatMap((r) =>
    r.viewerPersonId && !r.anonymized
      ? [{ club: r.clubId, viewer: r.viewerPersonId, viewed: r.viewedPersonId }]
      : [],
  );
  const { rows: found } = await tx.execute<{
    kind: "club" | "role";
    club_id: string | null;
    viewer: string | null;
    viewed: string | null;
    value: string | null;
  }>(sql`
    SELECT 'club' AS kind, c.id AS club_id, NULL::uuid AS viewer, NULL::uuid AS viewed, c.name AS value
    FROM public.clubs c WHERE c.id = ANY (${`{${clubIds.join(",")}}`}::uuid[])
    UNION ALL
    SELECT 'role', x.club, x.viewer, x.viewed,
      coalesce(
        (SELECT r.role FROM public.club_role_assignments r
         WHERE r.club_id = x.club AND r.person_id = x.viewer AND r.valid_to IS NULL
         ORDER BY array_position(${`{${ROLE_LABEL_ORDER.join(",")}}`}::text[], r.role::text)
         LIMIT 1),
        CASE WHEN EXISTS (SELECT 1 FROM public.group_memberships gm
          WHERE gm.club_id = x.club AND gm.person_id = x.viewer AND gm.valid_to IS NULL
            AND gm.leads) THEN 'group_leader' END,
        CASE WHEN EXISTS (SELECT 1 FROM public.guardianships g
          WHERE g.guardian_person_id = x.viewer AND g.ward_person_id = x.viewed
            AND g.status = 'active' AND g.valid_to IS NULL) THEN 'guardian' END,
        CASE WHEN EXISTS (SELECT 1 FROM public.club_memberships m
          WHERE m.club_id = x.club AND m.person_id = x.viewer AND m.valid_to IS NULL
            AND m.status IN ('active', 'paused')) THEN 'member' END)
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS x(club uuid, viewer uuid, viewed uuid)`);
  const clubNames = new Map<string, string>();
  const roles = new Map<string, ProfileViewerRole>();
  for (const f of found) {
    if (f.kind === "club" && f.club_id && f.value) clubNames.set(f.club_id, f.value);
    if (f.kind === "role" && f.viewer && f.value) {
      roles.set(roleKey(f.club_id, f.viewer, f.viewed), f.value as ProfileViewerRole);
    }
  }
  return { clubNames, roles };
}

/** The club's logging mode. */
export async function loggingMode(tx: Tx, clubId: string): Promise<ProfileViewLoggingMode> {
  const { rows } = await tx.execute<{ mode: ProfileViewLoggingMode }>(
    sql`SELECT profile_view_logging AS mode FROM public.clubs WHERE id = ${clubId}`,
  );
  return rows[0]?.mode ?? "protected_only";
}

/** Sets the club's logging mode; whether it changed. */
export async function setLoggingMode(
  tx: Tx,
  clubId: string,
  mode: ProfileViewLoggingMode,
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE public.clubs SET profile_view_logging = ${mode}
    WHERE id = ${clubId} AND profile_view_logging <> ${mode}`);
  return (result.rowCount ?? 0) > 0;
}

/** For the profile's protection state: the club flag and who set the person's global flag. */
export async function protectionDetails(
  tx: Tx,
  personId: string,
  clubId: string | null,
): Promise<{
  globalSetBy: string | null;
  globalSetByIsFullGuardian: boolean;
  club: boolean | null;
  clubSetAt: Date | null;
  clubSetBy: string | null;
}> {
  const { rows } = await tx.execute<{
    global_set_by: string | null;
    set_by_full: boolean;
    club: boolean | null;
    club_set_at: string | null;
    club_set_by: string | null;
  }>(sql`
    SELECT p.protected_identity_set_by_person_id AS global_set_by,
      privacy.is_active_full_guardian(p.protected_identity_set_by_person_id, p.id) AS set_by_full,
      cp.protected_identity_club AS club, cp.protected_identity_club_set_at AS club_set_at,
      cp.protected_identity_club_set_by_person_id AS club_set_by
    FROM public.people p
    LEFT JOIN public.club_profiles cp ON cp.club_id = ${clubId}::uuid AND cp.person_id = p.id
    WHERE p.id = ${personId}`);
  const r = rows[0];
  return {
    globalSetBy: r?.global_set_by ?? null,
    globalSetByIsFullGuardian: r?.set_by_full === true,
    club: clubId ? (r?.club ?? null) : null,
    clubSetAt: r?.club_set_at ? new Date(r.club_set_at) : null,
    clubSetBy: r?.club_set_by ?? null,
  };
}
