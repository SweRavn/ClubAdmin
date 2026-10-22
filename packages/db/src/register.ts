// SPDX-License-Identifier: AGPL-3.0-only
// The member register's filters and orderings as SQL (P1.2), shared by the
// API (pages, counts) and the worker (exports) so both select the same
// people. They apply to a row of app.register_entries aliased `e`; values are always parameters.

import type { RegisterFilter, RegisterSort } from "@clubadmin/shared";
import { type SQL, sql } from "drizzle-orm";

export const DEFAULT_REGISTER_STATUSES = ["active", "paused"] as const;

const textArray = (values: readonly string[]) => sql`${`{${values.join(",")}}`}::text[]`;

/** `%text%` for LIKE, with the pattern characters of the input escaped. */
const contains = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The WHERE conditions of a register query for one club. */
export function registerConditions(clubId: string, filter: RegisterFilter): SQL {
  const conditions: SQL[] = [sql`e.club_id = ${clubId}`];
  conditions.push(sql`e.status = ANY (${textArray(filter.status ?? DEFAULT_REGISTER_STATUSES)})`);
  if (filter.type) conditions.push(sql`e.membership_type = ANY (${textArray(filter.type)})`);
  if (filter.q !== undefined) {
    const q = filter.q.trim();
    const byName = sql`e.search_name LIKE ${contains(q)}`;
    conditions.push(
      /^\d{1,9}$/.test(q) ? sql`(e.member_number = ${Number(q)} OR ${byName})` : byName,
    );
  }
  if (filter.groupId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM public.group_memberships gm
      WHERE gm.club_id = e.club_id AND gm.person_id = e.person_id
        AND gm.group_id = ${filter.groupId} AND gm.valid_to IS NULL)`);
  }
  if (filter.role) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM public.club_role_assignments r
      WHERE r.club_id = e.club_id AND r.person_id = e.person_id
        AND r.role = ${filter.role} AND r.valid_to IS NULL)`);
  }
  if (filter.bornFrom !== undefined) {
    conditions.push(sql`e.birth_date >= make_date(${filter.bornFrom}::int, 1, 1)`);
  }
  if (filter.bornTo !== undefined) {
    conditions.push(sql`e.birth_date < make_date(${filter.bornTo + 1}::int, 1, 1)`);
  }
  if (filter.gender) {
    conditions.push(sql`(e.gender = ${filter.gender} AND 'gender' = ANY (e.shared_fields))`);
  }
  if (filter.missingConsent) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM public.consents c
      WHERE c.club_id = e.club_id AND c.person_id = e.person_id
        AND c.purpose = ${filter.missingConsent} AND c.revoked_at IS NULL)`);
  }
  return sql.join(conditions, sql` AND `);
}

/** The sort key of a register row (with person_id as the tie-breaker). */
export function registerSortKey(sort: RegisterSort): SQL {
  switch (sort) {
    case "member_number":
      return sql.raw("e.member_number");
    case "joined":
      return sql.raw("e.valid_from");
    case "name":
      return sql.raw("e.sort_name");
  }
}
