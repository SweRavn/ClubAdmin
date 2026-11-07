// SPDX-License-Identifier: AGPL-3.0-only
// waitlists:offers (P1.10b, ADR 0043), every five minutes as a system job:
// club by club where there is work (app.waitlist_offer_clubs), offers past
// their expiry become `expired` (the applicant is told), then groups with
// auto-offers and free places offer them to the next `waiting` entries in
// order, one per free place: never out of order, offered_by_person_id null.
// Set-based (one statement each per club) and idempotent; it catches up
// after downtime because it works from the current state, not the time.

import { audit, type Database, outbox, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

const JOB = "waitlists:offers";

export interface WaitlistOffersResult {
  clubs: number;
  expired: number;
  offered: number;
}

export async function runWaitlistOffers(db: Database): Promise<WaitlistOffersResult> {
  const { rows: clubs } = await db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`SELECT club_id FROM app.waitlist_offer_clubs()`),
  );
  const result: WaitlistOffersResult = { clubs: clubs.length, expired: 0, offered: 0 };
  for (const { club_id: clubId } of clubs) {
    await db.withSystem(JOB, { clubId }, async (tx) => {
      // Expired offers close; a join request made only for them is withdrawn
      // (nobody becomes a member without a group).
      const { rows: expired } = await tx.execute<{ id: string; join_request_id: string | null }>(
        sql`
        UPDATE public.group_waitlist_entries
        SET status = 'expired', closed_reason = 'expired', decided_at = now(),
          decided_by_person_id = NULL
        WHERE club_id = ${clubId} AND status = 'offered' AND offer_expires_at <= now()
        RETURNING id, join_request_id`,
      );
      for (const row of expired) {
        await audit.record(tx, {
          action: "group.waitlist.expired",
          resourceType: "group_waitlist_entry",
          resourceId: row.id,
          changedFields: ["status", "closed_reason"],
        });
        await outbox.publish(tx, "waitlist.offer.expired", { clubId, entryId: row.id });
      }
      const requests = [
        ...new Set(expired.flatMap((r) => (r.join_request_id ? [r.join_request_id] : []))),
      ];
      if (requests.length > 0) {
        const { rows: withdrawn } = await tx.execute<{ id: string }>(sql`
          UPDATE public.join_requests jr SET status = 'withdrawn', decided_at = now()
          WHERE jr.id = ANY (${sql`ARRAY[${sql.join(
            requests.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[]`}) AND jr.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM public.group_waitlist_entries w
              WHERE w.join_request_id = jr.id AND w.status IN ('waiting', 'offered', 'accepted'))
          RETURNING jr.id`);
        for (const row of withdrawn) {
          await audit.record(tx, {
            action: "join_request.withdrawn",
            resourceType: "join_request",
            resourceId: row.id,
            changedFields: ["status", "decided_at"],
          });
        }
      }

      // Free places of groups with auto-offers go to the next in line. The
      // groups are locked like an owner's offer locks them.
      const { rows: offered } = await tx.execute<{ id: string }>(sql`
        WITH g AS (
          SELECT g.id, g.offer_reply_days FROM public.groups g
          WHERE g.club_id = ${clubId} AND g.waitlist_auto_offer AND g.archived_at IS NULL
            AND g.admission_mode = 'waitlist'
          FOR UPDATE OF g
        ),
        free AS (
          SELECT g.id, g.offer_reply_days, pl.capacity - pl.occupied AS places
          FROM g CROSS JOIN LATERAL app.group_places(g.id) pl
          WHERE pl.capacity IS NOT NULL AND pl.occupied < pl.capacity
        ),
        next AS (
          SELECT e.id, f.offer_reply_days,
            row_number() OVER (PARTITION BY e.group_id ORDER BY e.priority DESC, e.queued_at, e.id) AS n,
            f.places
          FROM free f
          JOIN public.group_waitlist_entries e ON e.group_id = f.id AND e.status = 'waiting'
        )
        UPDATE public.group_waitlist_entries e
        SET status = 'offered', offered_at = now(), offered_by_person_id = NULL,
          decided_at = now(), decided_by_person_id = NULL, out_of_order_reason = NULL,
          offer_expires_at = ((((now() AT TIME ZONE c.time_zone)::date + nx.offer_reply_days + 1)::timestamp)
            AT TIME ZONE c.time_zone)
        FROM next nx, public.clubs c
        WHERE e.id = nx.id AND nx.n <= nx.places AND c.id = ${clubId}
        RETURNING e.id`);
      for (const row of offered) {
        await audit.record(tx, {
          action: "group.waitlist.offered",
          resourceType: "group_waitlist_entry",
          resourceId: row.id,
          changedFields: ["status", "offer_expires_at"],
        });
        await outbox.publish(tx, "waitlist.offer.sent", { clubId, entryId: row.id });
      }
      result.expired += expired.length;
      result.offered += offered.length;
    });
  }
  return result;
}

export function waitlistOffersTask(db: Database): Task {
  return async (_payload, helpers) => {
    const result = await runWaitlistOffers(db);
    if (result.expired || result.offered) helpers.logger.info("waitlist offers", { ...result });
  };
}
