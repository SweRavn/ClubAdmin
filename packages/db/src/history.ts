// SPDX-License-Identifier: AGPL-3.0-only
// Reading the record history (ADR 0017). Row-level security limits results to
// the current club. Actor IDs are resolved to names only by the API's person
// presenter (P0.7), so protected identities stay masked.

import { and, desc, eq, sql } from "drizzle-orm";

import type { Tx } from "./database.ts";
import { recordChanges } from "./infra/tables.ts";

export type RecordChange = typeof recordChanges.$inferSelect;

export interface RecordHistoryPage {
  items: RecordChange[];
  /** Pass to the next call to get older changes; null when there are none. */
  nextCursor: string | null;
}

const encodeCursor = (change: RecordChange) =>
  Buffer.from(JSON.stringify([change.changedAt.toISOString(), change.id])).toString("base64url");

function decodeCursor(cursor: string): [Date, string] {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
    throw new Error("invalid cursor");
  }
  return [new Date(parsed[0]), parsed[1]];
}

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
    const [changedAt, id] = decodeCursor(options.cursor);
    conditions.push(
      sql`(${recordChanges.changedAt}, ${recordChanges.id}) < (${changedAt.toISOString()}::timestamptz, ${id}::uuid)`,
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
