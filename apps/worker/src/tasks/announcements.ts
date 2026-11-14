// SPDX-License-Identifier: AGPL-3.0-only
// Scheduled announcements (P2.3, ADR 0053), `announcements:due` every
// minute: those whose time has come are sent (sent_at set, audited, and
// `announcement.sent` published for the notices), each in its club's
// transaction; a withdrawn one never is. Logs carry IDs.

import { audit, type Database, outbox, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

const BATCH = 100;

/** Sends the scheduled announcements due at `at`; returns how many were sent. */
export async function runDueAnnouncements(db: Database, at = new Date()): Promise<number> {
  const { rows: due } = await db.withSystem("announcements:due", {}, (tx) =>
    tx.execute<{ id: string; club_id: string }>(sql`
      SELECT a.id, a.club_id FROM public.announcements a
      WHERE a.sent_at IS NULL AND a.withdrawn_at IS NULL
        AND a.scheduled_at <= ${at.toISOString()}::timestamptz
      ORDER BY a.scheduled_at LIMIT ${BATCH}`),
  );
  let sent = 0;
  for (const row of due) {
    await db.withSystem("announcements:due", { clubId: row.club_id }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE public.announcements SET sent_at = now(), scheduled_at = NULL
        WHERE id = ${row.id}::uuid AND sent_at IS NULL AND withdrawn_at IS NULL
        RETURNING id`);
      if (rows.length === 0) return;
      await audit.record(tx, {
        action: "announcement.published",
        resourceType: "announcement",
        resourceId: row.id,
      });
      await outbox.publish(tx, "announcement.sent", {
        clubId: row.club_id,
        announcementId: row.id,
      });
      sent++;
    });
  }
  return sent;
}

export function dueAnnouncementsTask(db: Database): Task {
  return async (_payload, helpers) => {
    const sent = await runDueAnnouncements(db);
    if (sent > 0) helpers.logger.info("scheduled announcements sent", { sent });
  };
}
