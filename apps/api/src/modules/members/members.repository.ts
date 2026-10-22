// SPDX-License-Identifier: AGPL-3.0-only
// Reads of the member register (app.register_entries)
// and the member_exports table. Names never leave the database here: rows
// carry person IDs, the PersonPresenter resolves names.

import {
  and,
  desc,
  eq,
  registerConditions,
  registerSortKey,
  schema,
  type SQL,
  sql,
  type Tx,
} from "@clubadmin/db";
import type {
  ClubRole,
  ConsentPurpose,
  GroupFunction,
  GuardianshipKind,
  MembershipType,
  RegisterFilter,
  RegisterSort,
  RegisterStatus,
} from "@clubadmin/shared";

const { memberExports } = schema;

export type MemberExportRow = typeof memberExports.$inferSelect;
export type NewMemberExportRow = typeof memberExports.$inferInsert;

export interface RegisterRow {
  personId: string;
  status: RegisterStatus;
  membershipType: MembershipType;
  validFrom: string;
  validTo: string | null;
  memberNumber: number;
  birthDate: string | null;
  gender: string | null;
  sharedFields: string[];
  groups: { groupId: string; name: string; functions: GroupFunction[] }[];
  roles: ClubRole[];
  consents: ConsentPurpose[];
  guardians: { personId: string; kind: GuardianshipKind }[];
}

export interface RegisterPageRows {
  totalCount: number;
  cursorFound: boolean;
  items: RegisterRow[];
}

export interface RegisterPageInput {
  filter: RegisterFilter;
  sort: RegisterSort;
  order: "asc" | "desc";
  cursor: string | null;
  limit: number;
  /** Count hidden protected members too (not with a name search: it would reveal them). */
  countHidden: boolean;
}

/** Filters on the person's own columns: the count then needs people too. */
const PERSON_FILTERS = ["q", "bornFrom", "bornTo", "gender"] as const;

/** The statement of registerPage (query-plans test). */
export function registerPageQuery(clubId: string, page: RegisterPageInput) {
  const key = registerSortKey(page.sort);
  const where = registerConditions(clubId, page.filter);
  const direction = sql.raw(page.order === "desc" ? "DESC" : "ASC");
  const after = sql.raw(page.order === "desc" ? "<" : ">");
  // Rows the viewer may not see never reach the page (e.visible, the
  // database backstop). When the count needs people as well (a search, a
  // person filter, or counting only visible rows), one materialised pass
  // serves both; otherwise the count runs on its own, without people, and
  // the page can follow an index for member number and join date.
  const sharedPass = !page.countHidden || PERSON_FILTERS.some((f) => page.filter[f] !== undefined);
  const anchor = sql`anchor AS (
      SELECT ${key} AS k, e.person_id FROM app.register_entries e
      WHERE e.club_id = ${clubId} AND e.person_id = ${page.cursor}
      LIMIT 1
    )`;
  const afterCursor = (k: SQL, id: SQL) =>
    sql`(${page.cursor}::uuid IS NULL OR (${k}, ${id}) ${after} (SELECT a.k, a.person_id FROM anchor a))`;
  const ctes = sharedPass
    ? sql`${anchor}, matches AS MATERIALIZED (
      SELECT e.person_id, e.status, e.membership_type, e.valid_from, e.valid_to, e.member_number,
        e.birth_date, e.gender, e.shared_fields, e.visible, ${key} AS k
      FROM app.register_entries e
      WHERE ${where}
    ), page AS (
      SELECT x.*, row_number() OVER (ORDER BY x.k ${direction}, x.person_id ${direction}) AS ord
      FROM matches x
      WHERE x.visible AND ${afterCursor(sql`x.k`, sql`x.person_id`)}
      ORDER BY x.k ${direction}, x.person_id ${direction}
      LIMIT ${page.limit}
    )`
    : sql`${anchor}, page AS (
      SELECT e.person_id, e.status, e.membership_type, e.valid_from, e.valid_to, e.member_number,
        e.birth_date, e.gender, e.shared_fields,
        row_number() OVER (ORDER BY ${key} ${direction}, e.person_id ${direction}) AS ord
      FROM app.register_entries e
      WHERE ${where} AND e.visible AND ${afterCursor(key, sql`e.person_id`)}
      ORDER BY ${key} ${direction}, e.person_id ${direction}
      LIMIT ${page.limit}
    )`;
  const count = sharedPass
    ? sql`(SELECT count(*)::int FROM matches x WHERE ${page.countHidden ? sql`true` : sql`x.visible`})`
    : sql`(SELECT count(*)::int FROM app.register_entries e WHERE ${where})`;
  return sql`
    WITH ${ctes}
    SELECT
      ${count} AS total_count,
      (${page.cursor}::uuid IS NULL OR EXISTS (SELECT 1 FROM anchor)) AS cursor_found,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'personId', p.person_id,
        'status', p.status,
        'membershipType', p.membership_type,
        'validFrom', p.valid_from,
        'validTo', p.valid_to,
        'memberNumber', p.member_number,
        'birthDate', p.birth_date,
        'gender', p.gender,
        'sharedFields', to_jsonb(p.shared_fields),
        'groups', coalesce((
          SELECT jsonb_agg(jsonb_build_object('groupId', g.id, 'name', g.name, 'functions', g.functions) ORDER BY g.name)
          FROM (
            SELECT gr.id, gr.name, array_agg(gm.function ORDER BY gm.function) AS functions
            FROM public.group_memberships gm JOIN public.groups gr ON gr.id = gm.group_id
            WHERE gm.club_id = ${clubId} AND gm.person_id = p.person_id AND gm.valid_to IS NULL
              AND gr.archived_at IS NULL
            GROUP BY gr.id, gr.name
          ) g), '[]'),
        'roles', coalesce((
          SELECT jsonb_agg(r.role ORDER BY r.role) FROM public.club_role_assignments r
          WHERE r.club_id = ${clubId} AND r.person_id = p.person_id AND r.valid_to IS NULL), '[]'),
        'consents', coalesce((
          SELECT jsonb_agg(c.purpose ORDER BY c.purpose) FROM public.consents c
          WHERE c.club_id = ${clubId} AND c.person_id = p.person_id AND c.revoked_at IS NULL), '[]'),
        'guardians', coalesce((
          SELECT jsonb_agg(jsonb_build_object('personId', gs.guardian_person_id, 'kind', gs.kind) ORDER BY gs.created_at)
          FROM public.guardianships gs
          WHERE gs.ward_person_id = p.person_id AND gs.status = 'active' AND gs.valid_to IS NULL), '[]')
      ) ORDER BY p.ord) FROM page p), '[]') AS items`;
}

export async function registerPage(
  tx: Tx,
  clubId: string,
  page: RegisterPageInput,
): Promise<RegisterPageRows> {
  const { rows } = await tx.execute<{
    total_count: number;
    cursor_found: boolean;
    items: RegisterRow[];
  }>(registerPageQuery(clubId, page));
  const row = rows[0]!;
  return { totalCount: row.total_count, cursorFound: row.cursor_found, items: row.items };
}

export interface FacetRows {
  statuses: { value: RegisterStatus; count: number }[];
  types: { value: MembershipType; count: number }[];
  groups: { groupId: string; name: string; count: number }[];
}

/** The statement of registerFacets (query-plans test). */
export function registerFacetsQuery(clubId: string) {
  return sql`
    SELECT
      coalesce((SELECT jsonb_agg(jsonb_build_object('value', s.status, 'count', s.n) ORDER BY s.status)
        FROM (SELECT e.status, count(*)::int AS n FROM app.register_entries e
              WHERE e.club_id = ${clubId} GROUP BY e.status) s), '[]') AS statuses,
      coalesce((SELECT jsonb_agg(jsonb_build_object('value', t.membership_type, 'count', t.n) ORDER BY t.membership_type)
        FROM (SELECT m.membership_type, count(*)::int AS n FROM public.club_memberships m
              WHERE m.club_id = ${clubId} AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
              GROUP BY m.membership_type) t), '[]') AS types,
      coalesce((SELECT jsonb_agg(jsonb_build_object('groupId', g.id, 'name', g.name, 'count', g.n) ORDER BY g.name, g.id)
        FROM (SELECT gr.id, gr.name, count(DISTINCT gm.person_id)::int AS n
              FROM public.groups gr
              LEFT JOIN public.group_memberships gm
                ON gm.club_id = gr.club_id AND gm.group_id = gr.id AND gm.valid_to IS NULL
              WHERE gr.club_id = ${clubId} AND gr.archived_at IS NULL
              GROUP BY gr.id, gr.name) g), '[]') AS groups`;
}

export async function registerFacets(tx: Tx, clubId: string): Promise<FacetRows> {
  const { rows } = await tx.execute<{
    statuses: FacetRows["statuses"];
    types: FacetRows["types"];
    groups: FacetRows["groups"];
  }>(registerFacetsQuery(clubId));
  return rows[0]!;
}

// --- Exports ----------------------------------------------------------------

export async function insertExport(tx: Tx, values: NewMemberExportRow): Promise<MemberExportRow> {
  const [row] = await tx.insert(memberExports).values(values).returning();
  return row!;
}

export async function findExport(tx: Tx, exportId: string): Promise<MemberExportRow | null> {
  const [row] = await tx.select().from(memberExports).where(eq(memberExports.id, exportId));
  return row ?? null;
}

/** Exports requested in the last 24 hours, by the person and in the club. */
export async function recentExportCounts(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<{ byPerson: number; byClub: number }> {
  const { rows } = await tx.execute<{ by_person: number; by_club: number }>(sql`
    SELECT count(*) FILTER (WHERE requested_by_person_id = ${personId})::int AS by_person,
           count(*)::int AS by_club
    FROM public.member_exports
    WHERE club_id = ${clubId} AND created_at > now() - interval '24 hours'`);
  return { byPerson: rows[0]!.by_person, byClub: rows[0]!.by_club };
}

/** The club's exports, newest first (keyset on the UUIDv7 id). */
export async function listExports(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number },
): Promise<MemberExportRow[]> {
  return tx
    .select()
    .from(memberExports)
    .where(
      and(
        eq(memberExports.clubId, clubId),
        page.cursor ? sql`${memberExports.id} < ${page.cursor}` : undefined,
      ),
    )
    .orderBy(desc(memberExports.id))
    .limit(page.limit);
}
