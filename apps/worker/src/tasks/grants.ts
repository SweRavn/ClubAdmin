// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports (P2.7 part B, ADR 0051): attendance recorded or corrected for
// a session in a period whose report is locked (or exported, submitted)
// flags the report (`attendance_changed_at`); the locked evaluation itself
// stays as it was. Drafts are evaluated again on every read anyway.
// - The outbox handler enqueues grants:attendance_changed per session.
// - The job, in the club: the session's local date (the club's time zone)
//   against the club's reports (few: one per scheme and period).

import { type Database, type OutboxHandler, sql } from "@clubadmin/db";
import { z } from "@clubadmin/shared";
import type { Task } from "graphile-worker";

const JOB = "grants:attendance_changed";
const Payload = z.object({ clubId: z.uuid(), activityId: z.uuid() });

/** Flags the club's non-draft reports whose period has the session; reports flagged. */
export async function flagAttendanceChanged(
  db: Database,
  clubId: string,
  activityId: string,
): Promise<number> {
  return db.withSystem(JOB, { clubId }, async (tx) => {
    const result = await tx.execute(sql`
      UPDATE public.grant_reports r SET attendance_changed_at = now()
      FROM public.activities a JOIN public.clubs c ON c.id = a.club_id
      WHERE a.id = ${activityId} AND a.club_id = ${clubId} AND r.club_id = ${clubId}
        AND r.status <> 'draft'
        AND (a.starts_at AT TIME ZONE c.time_zone)::date BETWEEN r.period_from AND r.period_to`);
    return result.rowCount ?? 0;
  });
}

export function attendanceChangedTask(db: Database): Task {
  return async (payload) => {
    const { clubId, activityId } = Payload.parse(payload);
    await flagAttendanceChanged(db, clubId, activityId);
  };
}

export function grantsHandler(): OutboxHandler {
  return {
    name: "grants",
    types: ["attendance.recorded"],
    async handle(event, tx) {
      const { clubId, activityId } = Payload.parse(event.payload);
      await tx.execute(sql`
        SELECT graphile_worker.add_job(${JOB}, ${JSON.stringify({ clubId, activityId })}::json,
          job_key := ${`${JOB}:${activityId}`}, max_attempts := 10)`);
    },
  };
}
