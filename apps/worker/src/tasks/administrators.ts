// SPDX-License-Identifier: AGPL-3.0-only
// administrators:daily (P1.15 A3, ADR 0046), hourly as a system job, club by
// club where there is work (app.administrator_job_clubs): suspension
// requests past their 72 hours expire (the target and the initiator are
// told); a club with a grace period that now has two administrators leaves
// it; otherwise its administrators and the chair are reminded after 14 and
// 25 of the 30 days, and told when the club can no longer add members. Each
// notice once (dedupe keys); it works from the current state, so it catches
// up after downtime.

import { audit, type Database, outbox, sql } from "@clubadmin/db";
import { ADMINISTRATORS_GRACE_DAYS } from "@clubadmin/shared";
import type { Task } from "graphile-worker";

import { type Channels, createNotices } from "../notifications/fanout.ts";
import { administratorsAndChair } from "../notifications/handler.ts";

const JOB = "administrators:daily";
const DAY = 86_400_000;
/** Reminders on these days of the grace period (of ADMINISTRATORS_GRACE_DAYS). */
const REMINDER_DAYS = [14, 25] as const;

export interface AdministratorsJobResult {
  clubs: number;
  expired: number;
  reminded: number;
  needed: number;
}

export async function runAdministratorsJob(
  db: Database,
  options: { channels: Channels; now?: Date },
): Promise<AdministratorsJobResult> {
  const now = options.now ?? new Date();
  const { rows: clubs } = await db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`SELECT club_id FROM app.administrator_job_clubs()`),
  );
  const result: AdministratorsJobResult = {
    clubs: clubs.length,
    expired: 0,
    reminded: 0,
    needed: 0,
  };
  for (const { club_id: clubId } of clubs) {
    await db.withSystem(JOB, { clubId }, async (tx) => {
      const { rows: expired } = await tx.execute<{ id: string }>(sql`
        UPDATE public.administrator_suspensions SET status = 'expired', decided_at = now()
        WHERE club_id = ${clubId} AND status = 'requested' AND expires_at <= now()
        RETURNING id`);
      for (const { id } of expired) {
        await audit.record(tx, {
          action: "administrator.suspension.cancelled",
          resourceType: "administrator_suspension",
          resourceId: id,
          changedFields: ["status"],
        });
        await outbox.publish(tx, "administrator.suspension.closed", {
          clubId,
          suspensionId: id,
          status: "expired",
        });
      }
      result.expired += expired.length;

      await tx.execute(sql`SELECT app.end_administrators_grace(${clubId})`);
      const { rows } = await tx.execute<{ grace_until: string | null }>(sql`
        SELECT administrators_grace_until AS grace_until FROM public.clubs WHERE id = ${clubId}`);
      const graceUntil = rows[0]?.grace_until ? new Date(rows[0].grace_until) : null;
      if (!graceUntil) return;
      const start = graceUntil.getTime() - ADMINISTRATORS_GRACE_DAYS * DAY;
      const day = Math.floor((now.getTime() - start) / DAY);
      const ended = now >= graceUntil;
      const milestone = ended ? "ended" : [...REMINDER_DAYS].reverse().find((d) => day >= d);
      if (milestone === undefined) return;
      const recipients = await administratorsAndChair(tx, clubId);
      const type = ended ? "club.administrators.needed" : "club.administrators.grace_reminder";
      const created = await createNotices(
        tx,
        recipients.map((recipient) => ({
          recipientPersonId: recipient,
          clubId,
          type,
          subjectType: "club_administrators",
          subjectId: clubId,
          about: [],
          params: { graceUntil: graceUntil.toISOString() },
          dedupeKey: `${type}:${clubId}:${graceUntil.toISOString()}:${milestone}`,
        })),
        { channels: options.channels, now },
      );
      if (created > 0) {
        if (ended) result.needed += 1;
        else result.reminded += 1;
      }
    });
  }
  return result;
}

export function administratorsTask(db: Database, channels: Channels): Task {
  return async (_payload, helpers) => {
    const result = await runAdministratorsJob(db, { channels });
    helpers.logger.info(`administrators:daily ${JSON.stringify(result)}`);
  };
}
