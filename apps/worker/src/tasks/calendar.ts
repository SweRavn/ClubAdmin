// SPDX-License-Identifier: AGPL-3.0-only
// calendar:retention (P1.11, ADR 0044, docs/gdpr.md "retention:
// `calendar_feeds`"), daily as a system job: open feeds no calendar app has
// fetched for 12 months are revoked (`unused`; the owner is told through
// calendar.feed.revoked), and revoked feeds are deleted 30 days after they
// were revoked. Both statements use their partial index
// (calendar_feeds_unused_idx, calendar_feeds_revoked_idx). Record history
// keeps its own retention (ADR 0017); token_hash is redacted there.

import { audit, type Database, outbox, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

const JOB = "calendar:retention";

export interface CalendarRetentionResult {
  revoked: number;
  deleted: number;
}

export async function runCalendarRetention(
  db: Database,
  options: { unusedMonths?: number; deleteAfterDays?: number } = {},
): Promise<CalendarRetentionResult> {
  const unusedMonths = options.unusedMonths ?? 12;
  const deleteAfterDays = options.deleteAfterDays ?? 30;
  return db.withSystem(JOB, {}, async (tx) => {
    const { rows: revoked } = await tx.execute<{ id: string; person_id: string }>(sql`
      UPDATE public.calendar_feeds
      SET revoked_at = now(), revoked_reason = 'unused'
      WHERE revoked_at IS NULL
        AND coalesce(last_fetched_at, created_at) < now() - make_interval(months => ${unusedMonths})
      RETURNING id, person_id`);
    for (const row of revoked) {
      await audit.record(tx, {
        action: "calendar_feed.revoked",
        resourceType: "calendar_feed",
        resourceId: row.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
      await outbox.publish(tx, "calendar.feed.revoked", {
        feedId: row.id,
        personId: row.person_id,
      });
    }
    const deleted = await tx.execute(sql`
      DELETE FROM public.calendar_feeds
      WHERE revoked_at IS NOT NULL
        AND revoked_at < now() - make_interval(days => ${deleteAfterDays})`);
    return { revoked: revoked.length, deleted: deleted.rowCount ?? 0 };
  });
}

export function calendarRetentionTask(db: Database): Task {
  return async (_payload, helpers) => {
    const result = await runCalendarRetention(db);
    if (result.revoked || result.deleted) helpers.logger.info("calendar retention", { ...result });
  };
}
