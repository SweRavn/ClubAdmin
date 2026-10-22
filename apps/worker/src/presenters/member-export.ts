// SPDX-License-Identifier: AGPL-3.0-only
// Rows of a member register export (P1.2) with the names and contact fields
// the requester may see (CLAUDE.md rule 4, ADR 0022): the worker's
// counterpart of the API's RegisterPresenter. Exports are made by club
// managers and registrars, who see protected members; those are left out
// unless the export includes them, and then marked. Shareable fields only if
// the person shared them with the club.

import { registerConditions, sql, type Tx } from "@clubadmin/db";
import type { MemberExportColumn, RegisterFilter } from "@clubadmin/shared";

import { csvRow } from "../csv.ts";

export type ExportBatchRow = {
  person_id: string;
  sort_name: string;
  is_protected: boolean;
  name: string;
  member_number: number;
  birth_date: string | null;
  gender: string | null;
  status: string;
  membership_type: string;
  joined_on: string;
  left_on: string | null;
  phone: string | null;
  address: { street: string; postalCode: string; city: string; country: string } | null;
  groups: string[];
  roles: string[];
  consents: string[];
  guardians: { name: string; phone: string | null; protected: boolean }[];
};

/**
 * One batch of export rows in name order after `after` (keyset), for a club
 * whose context the transaction is in.
 */
export async function exportBatch(
  tx: Tx,
  clubId: string,
  options: {
    filter: RegisterFilter;
    includeProtected: boolean;
    timeZone: string;
    after: { sortName: string; personId: string } | null;
    limit: number;
  },
): Promise<ExportBatchRow[]> {
  const { rows } = await tx.execute<ExportBatchRow>(sql`
    SELECT e.person_id, e.sort_name, e.is_protected,
      p.given_name || ' ' || p.family_name AS name,
      e.member_number, e.birth_date,
      CASE WHEN 'gender' = ANY (e.shared_fields) THEN e.gender END AS gender,
      e.status, e.membership_type,
      (e.valid_from AT TIME ZONE ${options.timeZone})::date::text AS joined_on,
      (e.valid_to AT TIME ZONE ${options.timeZone})::date::text AS left_on,
      CASE WHEN 'phone' = ANY (e.shared_fields) THEN p.phone END AS phone,
      CASE WHEN 'address' = ANY (e.shared_fields) THEN p.address END AS address,
      ARRAY(SELECT gr.name FROM public.group_memberships gm
            JOIN public.groups gr ON gr.id = gm.group_id
            WHERE gm.club_id = e.club_id AND gm.person_id = e.person_id AND gm.valid_to IS NULL
              AND gr.archived_at IS NULL
            GROUP BY gr.name ORDER BY gr.name) AS groups,
      ARRAY(SELECT r.role FROM public.club_role_assignments r
            WHERE r.club_id = e.club_id AND r.person_id = e.person_id AND r.valid_to IS NULL
            ORDER BY r.role) AS roles,
      ARRAY(SELECT c.purpose FROM public.consents c
            WHERE c.club_id = e.club_id AND c.person_id = e.person_id AND c.revoked_at IS NULL) AS consents,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
          'name', g.given_name || ' ' || g.family_name,
          'phone', g.phone,
          'protected', g.protected_identity) ORDER BY gs.created_at)
        FROM public.guardianships gs JOIN public.people g ON g.id = gs.guardian_person_id
        WHERE gs.ward_person_id = e.person_id AND gs.status = 'active' AND gs.valid_to IS NULL), '[]') AS guardians
    FROM app.register_entries e
    JOIN public.people p ON p.id = e.person_id
    WHERE ${registerConditions(clubId, options.filter)}
      ${options.includeProtected ? sql`` : sql`AND NOT e.is_protected`}
      ${options.after ? sql`AND (e.sort_name, e.person_id) > (${options.after.sortName}, ${options.after.personId}::uuid)` : sql``}
    ORDER BY e.sort_name, e.person_id
    LIMIT ${options.limit}`);
  return rows;
}

export type Translate = (key: string) => string;

/** The header row in the requester's language. */
export function exportHeader(
  columns: readonly MemberExportColumn[],
  includeProtected: boolean,
  t: Translate,
): string {
  const headers = columns.map((c) => t(`memberExport.columns.${c}`));
  if (includeProtected) headers.push(t("memberExport.protectedColumn"));
  return csvRow(headers);
}

/** One CSV line of a member. */
export function exportLine(
  row: ExportBatchRow,
  columns: readonly MemberExportColumn[],
  options: { includeProtected: boolean; consentPurposes: readonly string[]; t: Translate },
): string {
  const { t } = options;
  const list = (values: readonly string[]) => values.join("; ");
  const value = (column: MemberExportColumn): string | number | null => {
    switch (column) {
      case "name":
        return row.name;
      case "memberNumber":
        return row.member_number;
      case "birthDate":
        return row.birth_date;
      case "gender":
        return row.gender ? t(`genders.${row.gender}`) : null;
      case "status":
        return t(`membershipStatus.${row.status}`);
      case "membershipType":
        return t(`membershipTypes.${row.membership_type}`);
      case "joinedOn":
        return row.joined_on;
      case "leftOn":
        return row.left_on;
      case "groups":
        return list(row.groups);
      case "roles":
        return list(row.roles.map((r) => t(`roles.${r}`)));
      case "phone":
        return row.phone;
      case "address":
        return row.address
          ? `${row.address.street}, ${row.address.postalCode} ${row.address.city}, ${row.address.country}`
          : null;
      case "guardians":
        return list(
          row.guardians
            .filter((g) => options.includeProtected || !g.protected)
            .map((g) => (g.phone ? `${g.name} (${g.phone})` : g.name)),
        );
      case "missingConsents":
        return list(
          options.consentPurposes
            .filter((p) => !row.consents.includes(p))
            .map((p) => t(`consentPurposes.${p}`)),
        );
    }
  };
  const cells = columns.map(value);
  if (options.includeProtected) cells.push(row.is_protected ? t("memberExport.protectedYes") : "");
  return csvRow(cells);
}
