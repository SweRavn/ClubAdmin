// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8): records, requests, the club's stricter
// requirements and what a person's roles need. Every statement runs in the
// caller's tenant transaction and starts from the club and the person
// (background_checks_person_idx, club_role_assignments_person_idx,
// group_memberships_person_idx) or the club's roles that need a check
// (club_role_assignments_role_idx, group_memberships_role_idx), never from
// a whole table.

import { sql, type Tx } from "@clubadmin/db";
import type { BackgroundCheckCategory, BackgroundCheckClubRequirement } from "@clubadmin/shared";

import type { CheckFact } from "./background-checks.rules.ts";

/** A uuid[] parameter (IDs from our own data). */
const uuidArray = (ids: readonly string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

export interface ClubFacts {
  country: string;
  timeZone: string;
  /** Plugins the club turned off (on by default otherwise). */
  disabledPluginIds: string[];
  clubRequirements: BackgroundCheckClubRequirement[];
}

export interface RecordRow extends CheckFact {
  personId: string;
  issuingCountry: string;
  verifiedOn: string;
  verifiedByPersonId: string | null;
  method: string;
  closedReason: "expired" | "superseded" | "closed" | null;
}

const CLUB_FACTS = (clubId: string) => sql`
  c.country, c.time_zone,
  coalesce((SELECT array_agg(p.plugin_id) FROM public.club_plugins p
    WHERE p.club_id = ${clubId} AND NOT p.enabled), '{}') AS disabled,
  coalesce((SELECT jsonb_agg(jsonb_build_object('pluginId', r.plugin_id, 'category', r.category,
      'checkType', r.check_type, 'recheckMonths', r.recheck_months)
      ORDER BY r.category, r.check_type)
    FROM public.background_check_club_requirements r WHERE r.club_id = ${clubId}), '[]') AS club_reqs`;

type RawClub = {
  country: string;
  time_zone: string;
  disabled: string[];
  club_reqs: BackgroundCheckClubRequirement[];
};
const toClub = (r: RawClub): ClubFacts => ({
  country: r.country,
  timeZone: r.time_zone,
  disabledPluginIds: r.disabled,
  clubRequirements: r.club_reqs,
});

const RECORD_JSON = sql`jsonb_build_object('id', bc.id, 'personId', bc.person_id,
  'pluginId', bc.plugin_id, 'checkType', bc.check_type, 'issuingCountry', bc.issuing_country,
  'issuedOn', bc.issued_on, 'verifiedOn', bc.verified_on,
  'verifiedByPersonId', bc.verified_by_person_id, 'method', bc.method,
  'validUntil', bc.valid_until, 'closedReason', bc.closed_reason_code)`;

/** The club's rules' inputs (one statement). */
export async function clubFacts(tx: Tx, clubId: string): Promise<ClubFacts> {
  const { rows } = await tx.execute<RawClub>(sql`
    SELECT ${CLUB_FACTS(clubId)} FROM public.clubs c WHERE c.id = ${clubId}`);
  if (!rows[0]) throw new Error("club not found");
  return toClub(rows[0]);
}

export interface PersonFacts {
  club: ClubFacts;
  /** The categories the person's open roles need, with the roles' IDs. */
  needs: { category: BackgroundCheckCategory; roleId: string }[];
  records: RecordRow[];
}

/**
 * The club's rules' inputs, what the person's roles need and their open
 * records, in one statement (enforcement in chat and duties).
 */
export async function personFacts(tx: Tx, clubId: string, personId: string): Promise<PersonFacts> {
  const { rows } = await tx.execute<
    RawClub & {
      needs: { category: BackgroundCheckCategory; roleId: string }[];
      records: RecordRow[];
    }
  >(sql`
    SELECT ${CLUB_FACTS(clubId)},
      coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('category', r.background_check_category,
          'roleId', r.id))
        FROM (SELECT a.role_id FROM public.club_role_assignments a
            WHERE a.person_id = ${personId} AND a.club_id = ${clubId} AND a.valid_to IS NULL
          UNION SELECT gm.role_id FROM public.group_memberships gm
            WHERE gm.person_id = ${personId} AND gm.club_id = ${clubId} AND gm.valid_to IS NULL) x
        JOIN public.roles r ON r.id = x.role_id AND r.club_id = ${clubId}
        WHERE r.background_check_category IS NOT NULL), '[]') AS needs,
      coalesce((SELECT jsonb_agg(${RECORD_JSON} ORDER BY bc.issued_on DESC)
        FROM public.background_checks bc
        WHERE bc.club_id = ${clubId} AND bc.person_id = ${personId} AND bc.closed_at IS NULL), '[]')
        AS records
    FROM public.clubs c WHERE c.id = ${clubId}`);
  const row = rows[0];
  if (!row) throw new Error("club not found");
  return { club: toClub(row), needs: row.needs, records: row.records };
}

/** Several people's open records (a shift's staff), one statement. */
export async function recordsOf(
  tx: Tx,
  clubId: string,
  personIds: readonly string[],
): Promise<RecordRow[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{ r: RecordRow }>(sql`
    SELECT ${RECORD_JSON} AS r FROM public.background_checks bc
    WHERE bc.club_id = ${clubId} AND bc.person_id = ANY (${uuidArray(personIds)})
      AND bc.closed_at IS NULL`);
  return rows.map((x) => x.r);
}

export interface OverviewRow {
  personId: string;
  categories: BackgroundCheckCategory[];
  /** When the person last held a role that needs a check (null: never ended, or never held). */
  lastNeededOn: string | null;
  records: RecordRow[];
  request: { id: string; status: string; createdAt: string } | null;
}

/**
 * Everyone the overview is about: the holders of the club's roles that need
 * a check (from those roles, by their indexes) and the people with open
 * records, each with their categories, records and open request. Its cost
 * follows the club's leaders, not the data of other clubs.
 */
export async function overviewRows(tx: Tx, clubId: string): Promise<OverviewRow[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    categories: BackgroundCheckCategory[] | null;
    records: RecordRow[] | null;
    request: OverviewRow["request"];
    last_needed_on: string | null;
  }>(sql`
    WITH need AS (
      SELECT h.person_id, array_agg(DISTINCT r.background_check_category) AS categories
      FROM public.roles r
      CROSS JOIN LATERAL (
        SELECT a.person_id FROM public.club_role_assignments a
        WHERE a.club_id = r.club_id AND a.role_id = r.id AND a.valid_to IS NULL
        UNION ALL
        SELECT gm.person_id FROM public.group_memberships gm
        WHERE gm.club_id = r.club_id AND gm.role_id = r.id AND gm.valid_to IS NULL) h
      WHERE r.club_id = ${clubId} AND r.archived_at IS NULL
        AND r.background_check_category IS NOT NULL
      GROUP BY h.person_id),
    recs AS (
      SELECT bc.person_id, jsonb_agg(${RECORD_JSON} ORDER BY bc.issued_on DESC) AS records
      FROM public.background_checks bc
      WHERE bc.club_id = ${clubId} AND bc.closed_at IS NULL
      GROUP BY bc.person_id),
    -- When those with records last held a role that needs a check: from the
    -- club's roles that need one, their ended holders by the person's index.
    ended AS (
      SELECT h.person_id, max(h.valid_to)::date AS last_needed_on
      FROM recs r
      CROSS JOIN LATERAL (
        SELECT a.person_id, a.valid_to FROM public.club_role_assignments a
        WHERE a.person_id = r.person_id AND a.club_id = ${clubId} AND a.valid_to IS NOT NULL
          AND a.role_id IN (SELECT ro.id FROM public.roles ro
            WHERE ro.club_id = ${clubId} AND ro.background_check_category IS NOT NULL)
        UNION ALL
        SELECT gm.person_id, gm.valid_to FROM public.group_memberships gm
        WHERE gm.person_id = r.person_id AND gm.club_id = ${clubId} AND gm.valid_to IS NOT NULL
          AND gm.role_id IN (SELECT ro.id FROM public.roles ro
            WHERE ro.club_id = ${clubId} AND ro.background_check_category IS NOT NULL)) h
      GROUP BY h.person_id),
    reqs AS (
      SELECT DISTINCT ON (q.person_id) q.person_id,
        jsonb_build_object('id', q.id, 'status', q.status, 'createdAt', q.created_at) AS request
      FROM public.background_check_requests q
      WHERE q.club_id = ${clubId} AND q.status NOT IN ('verified', 'closed')
      ORDER BY q.person_id, q.created_at DESC)
    SELECT p.person_id, n.categories, r.records, q.request, e.last_needed_on
    FROM (SELECT person_id FROM need UNION SELECT person_id FROM recs
          UNION SELECT person_id FROM reqs) p
    LEFT JOIN need n ON n.person_id = p.person_id
    LEFT JOIN recs r ON r.person_id = p.person_id
    LEFT JOIN ended e ON e.person_id = p.person_id
    LEFT JOIN reqs q ON q.person_id = p.person_id
    ORDER BY p.person_id`);
  return rows.map((r) => ({
    personId: r.person_id,
    categories: r.categories ?? [],
    lastNeededOn: r.last_needed_on,
    records: r.records ?? [],
    request: r.request,
  }));
}

/** Whether the person is in the club (a membership, a role or a group). */
export async function inClub(tx: Tx, clubId: string, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.club_memberships m
        WHERE m.person_id = ${personId} AND m.club_id = ${clubId} AND m.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.club_role_assignments a
        WHERE a.person_id = ${personId} AND a.club_id = ${clubId} AND a.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.group_memberships gm
        WHERE gm.person_id = ${personId} AND gm.club_id = ${clubId} AND gm.valid_to IS NULL) AS ok`);
  return rows[0]?.ok === true;
}

/**
 * A new record; the person's earlier open records of the same type are
 * superseded by it. Returns the new record's ID.
 */
export async function insertRecord(
  tx: Tx,
  clubId: string,
  values: {
    personId: string;
    pluginId: string;
    checkType: string;
    issuingCountry: string;
    issuedOn: string;
    verifiedOn: string;
    verifiedByPersonId: string;
    method: string;
    validUntil: string | null;
  },
): Promise<{ id: string; superseded: number }> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.background_checks (club_id, person_id, plugin_id, check_type,
      issuing_country, issued_on, verified_on, verified_by_person_id, method, valid_until)
    VALUES (${clubId}, ${values.personId}, ${values.pluginId}, ${values.checkType},
      ${values.issuingCountry}, ${values.issuedOn}::date, ${values.verifiedOn}::date,
      ${values.verifiedByPersonId}, ${values.method}, ${values.validUntil}::date)
    RETURNING id`);
  const id = rows[0]!.id;
  const superseded = await tx.execute(sql`
    UPDATE public.background_checks
    SET closed_at = now(), closed_reason_code = 'superseded', superseded_by_id = ${id}
    WHERE club_id = ${clubId} AND person_id = ${values.personId} AND id <> ${id}
      AND plugin_id = ${values.pluginId} AND check_type = ${values.checkType}
      AND closed_at IS NULL`);
  return { id, superseded: superseded.rowCount ?? 0 };
}

/** The person's open requests of the type are done: verified with this record. */
export async function completeRequests(
  tx: Tx,
  clubId: string,
  personId: string,
  pluginId: string,
  checkType: string,
  checkId: string,
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE public.background_check_requests SET status = 'verified', check_id = ${checkId}
    WHERE club_id = ${clubId} AND person_id = ${personId} AND plugin_id = ${pluginId}
      AND check_type = ${checkType} AND status NOT IN ('verified', 'closed')`);
  return result.rowCount ?? 0;
}

export async function getRecord(
  tx: Tx,
  clubId: string,
  recordId: string,
): Promise<RecordRow | null> {
  const { rows } = await tx.execute<{ r: RecordRow }>(sql`
    SELECT ${RECORD_JSON} AS r FROM public.background_checks bc
    WHERE bc.club_id = ${clubId} AND bc.id = ${recordId}`);
  return rows[0]?.r ?? null;
}

/** Deletes a record (and unlinks the records and requests that point at it). */
export async function deleteRecord(tx: Tx, clubId: string, recordId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.background_checks SET superseded_by_id = NULL
    WHERE club_id = ${clubId} AND superseded_by_id = ${recordId}`);
  await tx.execute(sql`
    DELETE FROM public.background_checks WHERE club_id = ${clubId} AND id = ${recordId}`);
}

export async function insertRequest(
  tx: Tx,
  clubId: string,
  values: {
    personId: string;
    pluginId: string;
    checkType: string;
    status: string;
    reference: string;
    requestedByPersonId: string;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.background_check_requests (club_id, person_id, plugin_id, check_type,
      status, plugin_reference, requested_by_person_id)
    VALUES (${clubId}, ${values.personId}, ${values.pluginId}, ${values.checkType},
      ${values.status}, ${values.reference}, ${values.requestedByPersonId})
    RETURNING id`);
  return rows[0]!.id;
}

/** The club's roles (not deleted) with their categories. */
export async function rolesWithCategories(
  tx: Tx,
  clubId: string,
): Promise<
  {
    id: string;
    scope: "club" | "group";
    templateKey: string | null;
    names: Record<string, string> | null;
    category: BackgroundCheckCategory | null;
  }[]
> {
  const { rows } = await tx.execute<{
    id: string;
    scope: "club" | "group";
    template_key: string | null;
    names: Record<string, string> | null;
    category: BackgroundCheckCategory | null;
  }>(sql`
    SELECT r.id, r.scope, r.template_key, r.names, r.background_check_category AS category
    FROM public.roles r WHERE r.club_id = ${clubId} AND r.archived_at IS NULL
    ORDER BY r.scope, r.sort_order, r.created_at`);
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    templateKey: r.template_key,
    names: r.names,
    category: r.category,
  }));
}

export async function dutyTypes(
  tx: Tx,
  clubId: string,
): Promise<
  {
    id: string;
    name: string;
    childContact: "none" | "with_children" | "alone_with_children";
    category: BackgroundCheckCategory | null;
  }[]
> {
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    child_contact: "none" | "with_children" | "alone_with_children";
    category: BackgroundCheckCategory | null;
  }>(sql`
    SELECT t.id, t.name, t.child_contact, t.background_check_category AS category
    FROM public.duty_types t WHERE t.club_id = ${clubId} AND t.archived_at IS NULL
    ORDER BY lower(t.name)`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    childContact: r.child_contact,
    category: r.category,
  }));
}

/** Replaces the club's stricter requirements. */
export async function replaceClubRequirements(
  tx: Tx,
  clubId: string,
  items: readonly BackgroundCheckClubRequirement[],
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM public.background_check_club_requirements WHERE club_id = ${clubId}`);
  for (const r of items) {
    await tx.execute(sql`
      INSERT INTO public.background_check_club_requirements
        (club_id, plugin_id, category, check_type, recheck_months)
      VALUES (${clubId}, ${r.pluginId}, ${r.category}, ${r.checkType}, ${r.recheckMonths})`);
  }
}

export async function setDutyTypeCategory(
  tx: Tx,
  clubId: string,
  dutyTypeId: string,
  category: BackgroundCheckCategory | null,
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE public.duty_types SET background_check_category = ${category}
    WHERE club_id = ${clubId} AND id = ${dutyTypeId}
      AND background_check_category IS DISTINCT FROM ${category}`);
  return (result.rowCount ?? 0) > 0;
}

/** The clubs in these countries that are not archived (a background job). */
export async function activeClubsIn(tx: Tx, countries: readonly string[]): Promise<string[]> {
  if (countries.length === 0) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.clubs
    WHERE status <> 'archived' AND country = ANY (string_to_array(${countries.join(",")}, ','))
    ORDER BY id`);
  return rows.map((r) => r.id);
}
