// SPDX-License-Identifier: AGPL-3.0-only
// calendar_feeds (P1.11): the owner reads and writes their own rows under
// row-level security; a fetch finds its feed by the secret's hash through
// app.find_calendar_feed; system jobs and answer links read by ID.

import { and, eq, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { CalendarFeedRevokedReason, CalendarFeedScope } from "@clubadmin/shared";

const { calendarFeeds } = schema;

export type FeedRow = typeof calendarFeeds.$inferSelect;

export async function insertFeed(
  tx: Tx,
  values: typeof calendarFeeds.$inferInsert,
): Promise<FeedRow> {
  const [row] = await tx.insert(calendarFeeds).values(values).returning();
  return row!;
}

/** The person's open feeds, newest first (calendar_feeds_person_idx). */
export async function openFeeds(tx: Tx, personId: string): Promise<FeedRow[]> {
  return tx
    .select()
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.personId, personId), isNull(calendarFeeds.revokedAt)))
    .orderBy(sql`${calendarFeeds.createdAt} DESC`)
    .limit(50);
}

export async function lockOwnFeed(tx: Tx, id: string, personId: string): Promise<FeedRow | null> {
  const [row] = await tx
    .select()
    .from(calendarFeeds)
    .where(
      and(
        eq(calendarFeeds.id, id),
        eq(calendarFeeds.personId, personId),
        isNull(calendarFeeds.revokedAt),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function updateFeed(
  tx: Tx,
  id: string,
  patch: Partial<typeof calendarFeeds.$inferInsert>,
): Promise<FeedRow> {
  const [row] = await tx
    .update(calendarFeeds)
    .set(patch)
    .where(eq(calendarFeeds.id, id))
    .returning();
  return row!;
}

export async function revokeFeed(
  tx: Tx,
  id: string,
  reason: CalendarFeedRevokedReason,
): Promise<void> {
  await tx
    .update(calendarFeeds)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(calendarFeeds.id, id), isNull(calendarFeeds.revokedAt)));
}

export interface FoundFeed {
  id: string;
  personId: string;
  scope: CalendarFeedScope;
  clubId: string | null;
  groupId: string | null;
  personIds: string[];
  lastFetchedAt: Date | null;
  accessLostAt: Date | null;
}

/** The open feed of a secret's hash (app.find_calendar_feed), or null. */
export async function findByTokenHash(tx: Tx, tokenHash: string): Promise<FoundFeed | null> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    scope: CalendarFeedScope;
    club_id: string | null;
    group_id: string | null;
    person_ids: string[];
    last_fetched_at: string | null;
    access_lost_at: string | null;
  }>(sql`SELECT * FROM app.find_calendar_feed(${tokenHash})`);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        personId: r.person_id,
        scope: r.scope,
        clubId: r.club_id,
        groupId: r.group_id,
        personIds: r.person_ids,
        lastFetchedAt: r.last_fetched_at ? new Date(r.last_fetched_at) : null,
        accessLostAt: r.access_lost_at ? new Date(r.access_lost_at) : null,
      }
    : null;
}

/** A feed by ID (answer links; a system transaction). */
export async function findById(tx: Tx, id: string): Promise<FeedRow | null> {
  const [row] = await tx.select().from(calendarFeeds).where(eq(calendarFeeds.id, id));
  return row ?? null;
}

/** Marks the fetch, at most once an hour (no history: the column is ignored). */
export async function touchFetched(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.calendar_feeds SET last_fetched_at = now()
    WHERE id = ${id} AND (last_fetched_at IS NULL OR last_fetched_at < now() - interval '1 hour')`);
}

export async function countOpen(tx: Tx, personId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.calendar_feeds
    WHERE person_id = ${personId} AND revoked_at IS NULL`);
  return rows[0]?.n ?? 0;
}
