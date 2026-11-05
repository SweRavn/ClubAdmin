// SPDX-License-Identifier: AGPL-3.0-only
// Reading the record history and the audit log (ADR 0017, ADR 0042).
// Row-level security limits club rows to the current club; global rows
// (people, guardianships) come only through history.read_global_changes.
// Actor IDs are resolved to names only by the API's person presenter, so
// protected identities stay masked. Every reader is newest first with a
// keyset cursor on (changed_at, id) or (created_at, id).

import { and, desc, eq, type SQL, sql } from "drizzle-orm";

import type { Tx } from "./database.ts";
import { recordChanges } from "./infra/tables.ts";

export type RecordChange = typeof recordChanges.$inferSelect;

export interface RecordHistoryPage {
  items: RecordChange[];
  /** Pass to the next call to get older changes; null when there are none. */
  nextCursor: string | null;
}

/** A keyset position: the time and ID of the last item of a page. */
export interface HistoryPosition {
  at: Date;
  id: string;
}

export class InvalidHistoryCursorError extends Error {
  constructor() {
    super("invalid cursor");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeHistoryCursor = (at: Date, id: string): string =>
  Buffer.from(JSON.stringify([at.toISOString(), id])).toString("base64url");

/** The position in an opaque cursor; throws InvalidHistoryCursorError. */
export function decodeHistoryCursor(cursor: string): HistoryPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidHistoryCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !UUID.test(parsed[1])
  ) {
    throw new InvalidHistoryCursorError();
  }
  const at = new Date(parsed[0]);
  if (Number.isNaN(at.getTime())) throw new InvalidHistoryCursorError();
  return { at, id: parsed[1] };
}

const encodeCursor = (change: RecordChange) => encodeHistoryCursor(change.changedAt, change.id);

/** Newest first, keyset-paginated. `table` is schema-qualified, e.g. "public.groups". */
export async function getRecordHistory(
  tx: Tx,
  table: string,
  recordId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<RecordHistoryPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions = [eq(recordChanges.tableName, table), eq(recordChanges.recordId, recordId)];
  if (options.cursor) {
    const { at, id } = decodeHistoryCursor(options.cursor);
    conditions.push(
      sql`(${recordChanges.changedAt}, ${recordChanges.id}) < (${at.toISOString()}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(recordChanges)
    .where(and(...conditions))
    .orderBy(desc(recordChanges.changedAt), desc(recordChanges.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** A record whose history is read: schema-qualified table and ID. */
export interface HistoryRecordRef {
  table: string;
  id: string;
}

export interface HistoryPageOptions {
  before: HistoryPosition | null;
  /** Rows to return (the caller asks for one more to know whether there is a next page). */
  limit: number;
}

type RawChange = {
  id: string;
  changed_at: string | Date;
  table_name: string;
  record_id: string;
  club_id: string | null;
  operation: RecordChange["operation"];
  changed_columns: string[];
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  actor_person_id: string | null;
  on_behalf_of_person_id: string | null;
  actor_kind: string;
  request_id: string | null;
  transaction_id: string | number;
  db_role: string;
};

const toChange = (r: RawChange): RecordChange => ({
  id: r.id,
  changedAt: new Date(r.changed_at),
  tableName: r.table_name,
  recordId: r.record_id,
  clubId: r.club_id,
  operation: r.operation,
  changedColumns: r.changed_columns,
  oldValues: r.old_values,
  newValues: r.new_values,
  actorPersonId: r.actor_person_id,
  onBehalfOfPersonId: r.on_behalf_of_person_id,
  actorKind: r.actor_kind,
  requestId: r.request_id,
  transactionId: Number(r.transaction_id),
  dbRole: r.db_role,
});

/** A text[]/uuid[] parameter (table names and IDs only, validated where they enter). */
const pgArray = (values: readonly string[]) => `{${values.join(",")}}`;

const limitOf = (limit: number) => Math.min(Math.max(Math.trunc(limit), 1), 201);

const beforeClause = (alias: string, before: HistoryPosition | null, column = "changed_at") =>
  before
    ? sql`AND (${sql.raw(`${alias}.${column}`)}, ${sql.raw(`${alias}.id`)}) < (${before.at.toISOString()}::timestamptz, ${before.id}::uuid)`
    : sql``;

/**
 * The club rows' history of a set of records (a detail page's panel), in
 * the current club (row-level security). One index range per record and
 * partition (record_changes_record_idx), each limited to the page.
 */
export function recordsHistorySql(
  records: readonly HistoryRecordRef[],
  options: HistoryPageOptions,
): SQL {
  const limit = limitOf(options.limit);
  return sql`
    SELECT h.* FROM unnest(${pgArray(records.map((r) => r.table))}::text[],
      ${pgArray(records.map((r) => r.id))}::uuid[]) AS s(table_name, record_id)
    CROSS JOIN LATERAL (
      SELECT c.* FROM history.record_changes c
      WHERE c.table_name = s.table_name AND c.record_id = s.record_id
        ${beforeClause("c", options.before)}
      ORDER BY c.changed_at DESC, c.id DESC
      LIMIT ${limit}
    ) h
    ORDER BY h.changed_at DESC, h.id DESC
    LIMIT ${limit}`;
}

export async function readRecordsHistory(
  tx: Tx,
  records: readonly HistoryRecordRef[],
  options: HistoryPageOptions,
): Promise<RecordChange[]> {
  if (records.length === 0) return [];
  const { rows } = await tx.execute<RawChange>(recordsHistorySql(records, options));
  return rows.map(toChange);
}

/** The global rows' history (people, guardianships) through history.read_global_changes. */
export async function readGlobalHistory(
  tx: Tx,
  records: readonly HistoryRecordRef[],
  options: HistoryPageOptions,
): Promise<RecordChange[]> {
  if (records.length === 0) return [];
  const { rows } = await tx.execute<RawChange>(sql`
    SELECT * FROM history.read_global_changes(
      ${pgArray(records.map((r) => r.table))}::text[],
      ${pgArray(records.map((r) => r.id))}::uuid[],
      ${options.before?.at.toISOString() ?? null}::timestamptz,
      ${options.before?.id ?? null}::uuid,
      ${limitOf(options.limit)})`);
  return rows.map(toChange);
}

export interface ClubHistoryFilter {
  /** Schema-qualified table names (any of them). */
  tables?: readonly string[];
  actorPersonId?: string;
  from?: Date;
  to?: Date;
}

/**
 * The club's changes (club-wide view), newest first on the club index
 * (record_changes_club_keyset_idx, a MergeAppend over the partitions); a
 * date range prunes partitions, filters by table or actor run inside it.
 */
export function clubHistorySql(
  clubId: string,
  filter: ClubHistoryFilter,
  options: HistoryPageOptions,
): SQL {
  const conditions = [sql`c.club_id = ${clubId}`];
  if (filter.from) conditions.push(sql`c.changed_at >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to) conditions.push(sql`c.changed_at < ${filter.to.toISOString()}::timestamptz`);
  if (filter.tables && filter.tables.length > 0) {
    conditions.push(sql`c.table_name = ANY (${pgArray(filter.tables)}::text[])`);
  }
  if (filter.actorPersonId) conditions.push(sql`c.actor_person_id = ${filter.actorPersonId}`);
  return sql`
    SELECT c.* FROM history.record_changes c
    WHERE ${sql.join(conditions, sql` AND `)} ${beforeClause("c", options.before)}
    ORDER BY c.changed_at DESC, c.id DESC
    LIMIT ${limitOf(options.limit)}`;
}

export async function readClubHistory(
  tx: Tx,
  clubId: string,
  filter: ClubHistoryFilter,
  options: HistoryPageOptions,
): Promise<RecordChange[]> {
  const { rows } = await tx.execute<RawChange>(clubHistorySql(clubId, filter, options));
  return rows.map(toChange);
}

export interface AuditEventRow {
  id: string;
  createdAt: Date;
  actorPersonId: string | null;
  onBehalfOfPersonId: string | null;
  actorKind: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  changedFields: string[];
  requestId: string | null;
}

export interface AuditEventFilter {
  actions?: readonly string[];
  actorPersonId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}

/**
 * The club's audit events, newest first (events_club_idx; by actor
 * events_club_actor_idx, by resource events_resource_keyset_idx). Never
 * ip_hash.
 */
export function auditEventsSql(
  clubId: string,
  filter: AuditEventFilter,
  options: HistoryPageOptions,
): SQL {
  const conditions = [sql`e.club_id = ${clubId}`];
  if (filter.from) conditions.push(sql`e.created_at >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to) conditions.push(sql`e.created_at < ${filter.to.toISOString()}::timestamptz`);
  if (filter.actions && filter.actions.length > 0) {
    conditions.push(sql`e.action = ANY (${pgArray(filter.actions)}::text[])`);
  }
  if (filter.actorPersonId) conditions.push(sql`e.actor_person_id = ${filter.actorPersonId}`);
  if (filter.resourceType) conditions.push(sql`e.resource_type = ${filter.resourceType}`);
  if (filter.resourceId) conditions.push(sql`e.resource_id = ${filter.resourceId}`);
  return sql`
    SELECT e.id, e.created_at, e.actor_person_id, e.on_behalf_of_person_id, e.actor_kind,
      e.action, e.resource_type, e.resource_id, e.changed_fields, e.request_id
    FROM audit.events e
    WHERE ${sql.join(conditions, sql` AND `)} ${beforeClause("e", options.before, "created_at")}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limitOf(options.limit)}`;
}

export async function readAuditEvents(
  tx: Tx,
  clubId: string,
  filter: AuditEventFilter,
  options: HistoryPageOptions,
): Promise<AuditEventRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    created_at: string | Date;
    actor_person_id: string | null;
    on_behalf_of_person_id: string | null;
    actor_kind: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    changed_fields: string[];
    request_id: string | null;
  }>(auditEventsSql(clubId, filter, options));
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at),
    actorPersonId: r.actor_person_id,
    onBehalfOfPersonId: r.on_behalf_of_person_id,
    actorKind: r.actor_kind,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    changedFields: r.changed_fields,
    requestId: r.request_id,
  }));
}
