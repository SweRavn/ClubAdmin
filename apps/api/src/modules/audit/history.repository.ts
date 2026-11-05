// SPDX-License-Identifier: AGPL-3.0-only
// Statements of the history panels (P1.9, ADR 0042), all read in the club's
// context (row-level security): which records make up a detail page's
// history (the panel scope, IDs only, including ended rows), the current
// rows' "about" columns for a page of changes, and the names of the groups,
// places, activities, series, events, clubs and seasons they mention.
// People are only IDs here; names come from PeopleService and the presenter.

import { type HistoryRecordRef, sql, type Tx } from "@clubadmin/db";
import { HISTORY_SCOPE_MAX, type HistoryRecordKind } from "@clubadmin/shared";

import { HISTORY_POLICY, type TablePolicy } from "./history-columns.ts";

export type PanelKind = "person" | "group" | "activity" | "series" | "event" | "club";

/** A uuid[] parameter (IDs only, validated where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

/** The tables and the column that ties their rows to the panel's record. */
const SCOPES: Record<PanelKind, readonly [table: string, column: string][]> = {
  person: [
    ["public.club_profiles", "person_id"],
    ["public.club_memberships", "person_id"],
    ["public.group_memberships", "person_id"],
    ["public.club_role_assignments", "person_id"],
    ["public.employments", "person_id"],
    ["public.consents", "person_id"],
    ["public.join_requests", "person_id"],
    ["public.group_waitlist_entries", "person_id"],
    // Global rows (no club_id), read through history.read_global_changes.
    ["public.people", "id"],
    ["public.guardianships", "ward_person_id"],
    ["public.guardianships", "guardian_person_id"],
  ],
  group: [
    ["public.groups", "id"],
    ["public.group_owners", "group_id"],
    ["public.group_memberships", "group_id"],
    ["public.group_seasons", "group_id"],
    ["public.group_waitlist_entries", "group_id"],
  ],
  activity: [
    ["public.activities", "id"],
    ["public.activity_groups", "activity_id"],
    ["public.activity_responses", "activity_id"],
    ["public.attendance_records", "activity_id"],
    ["public.activity_invitees", "activity_id"],
  ],
  series: [
    ["public.activity_series", "id"],
    ["public.activity_series_groups", "series_id"],
  ],
  event: [
    ["public.events", "id"],
    ["public.event_groups", "event_id"],
    ["public.event_activities", "event_id"],
    ["public.event_registrations", "event_id"],
  ],
  club: [
    ["public.clubs", "id"],
    ["public.locations", "club_id"],
    ["public.club_phone_numbers", "club_id"],
    ["public.consent_texts", "club_id"],
    ["public.club_setting_decisions", "club_id"],
    ["public.club_privacy_policies", "club_id"],
    ["public.support_access_grants", "club_id"],
  ],
};

/** Tables without a club_id column (the club itself and the global rows). */
const NO_CLUB_ID = new Set(["public.clubs", "public.people", "public.guardianships"]);

export const scopeTables = (kind: PanelKind): string[] => SCOPES[kind].map(([t]) => t);

/**
 * The club rows of a panel (one statement), at most HISTORY_SCOPE_MAX + 1
 * (the caller refuses larger scopes). Each part uses the table's index on
 * the tying column; ended rows are included (they are kept with valid_to).
 */
export async function panelScope(
  tx: Tx,
  kind: PanelKind,
  clubId: string,
  id: string,
): Promise<HistoryRecordRef[]> {
  const parts = SCOPES[kind].map(
    ([table, column]) =>
      sql`(SELECT ${table}::text AS t, x.id FROM ${sql.raw(table)} x
        WHERE x.${sql.raw(column)} = ${id}${NO_CLUB_ID.has(table) ? sql`` : sql` AND x.club_id = ${clubId}`})`,
  );
  const { rows } = await tx.execute<{ t: string; id: string }>(
    sql`${sql.join(parts, sql` UNION ALL `)} LIMIT ${HISTORY_SCOPE_MAX + 1}`,
  );
  return rows.map((r) => ({ table: r.t, id: r.id }));
}

/** The columns a page needs from a table's current rows: its about and link columns. */
function contextColumns(policy: TablePolicy): string[] {
  const columns = new Set(policy.about.map((a) => a.column));
  if (policy.link) columns.add(policy.link.column);
  columns.delete("id");
  return [...columns];
}

/**
 * The about and link columns of the current rows behind a page of changes
 * (one statement over the tables on the page). Rows that no longer exist
 * are missing; the caller falls back to the change's own values.
 */
export async function currentContext(
  tx: Tx,
  records: readonly HistoryRecordRef[],
): Promise<Map<string, Record<string, string | null>>> {
  const byTable = new Map<string, string[]>();
  for (const r of records) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id]);
  const parts = [];
  for (const [table, ids] of byTable) {
    const policy = HISTORY_POLICY.find((p) => p.table === table);
    const columns = policy ? contextColumns(policy) : [];
    if (columns.length === 0) continue;
    const object = sql.join(
      columns.map((column) => sql`${column}::text, x.${sql.raw(column)}::text`),
      sql`, `,
    );
    parts.push(
      sql`(SELECT x.id, jsonb_build_object(${object}) AS ctx FROM ${sql.raw(table)} x
        WHERE x.id = ANY (${uuidArray([...new Set(ids)])}::uuid[]))`,
    );
  }
  if (parts.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; ctx: Record<string, string | null> }>(
    sql.join(parts, sql` UNION ALL `),
  );
  return new Map(rows.map((r) => [r.id, r.ctx]));
}

export interface RecordName {
  name: string | null;
  startsAt: string | null;
}

// Every part names its columns: a UNION takes the names of its first part.
const NAME_SOURCES: Record<Exclude<HistoryRecordKind, "person">, ReturnType<typeof sql>> = {
  group: sql`SELECT 'group' AS k, id, name, NULL::timestamptz AS starts_at FROM public.groups`,
  location: sql`SELECT 'location' AS k, id, name, NULL::timestamptz AS starts_at FROM public.locations`,
  activity: sql`SELECT 'activity' AS k, id, coalesce(title, kind_label) AS name, starts_at FROM public.activities`,
  series: sql`SELECT 'series' AS k, id, title AS name, NULL::timestamptz AS starts_at FROM public.activity_series`,
  event: sql`SELECT 'event' AS k, id, title AS name, starts_at FROM public.events`,
  club: sql`SELECT 'club' AS k, id, name, NULL::timestamptz AS starts_at FROM public.clubs`,
  season: sql`SELECT 'season' AS k, id, name, NULL::timestamptz AS starts_at FROM public.seasons`,
};

/** Names of the records a page mentions, one statement for every kind ("kind:id" keys). */
export async function recordNames(
  tx: Tx,
  refs: ReadonlyMap<Exclude<HistoryRecordKind, "person">, ReadonlySet<string>>,
): Promise<Map<string, RecordName>> {
  const parts = [];
  for (const [kind, ids] of refs) {
    if (ids.size === 0) continue;
    parts.push(sql`(${NAME_SOURCES[kind]} WHERE id = ANY (${uuidArray([...ids])}::uuid[]))`);
  }
  if (parts.length === 0) return new Map();
  const { rows } = await tx.execute<{
    k: string;
    id: string;
    name: string | null;
    starts_at: string | Date | null;
  }>(sql.join(parts, sql` UNION ALL `));
  return new Map(
    rows.map((r) => [
      `${r.k}:${r.id}`,
      { name: r.name, startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null },
    ]),
  );
}
