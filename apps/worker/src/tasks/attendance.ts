// SPDX-License-Identifier: AGPL-3.0-only
// Retention of answers and attendance (#18, ADR 0035): each club keeps them
// for attendance_retention_months (at least 12, 12 by default) after the
// activity ended; then app.purge_expired_attendance deletes them, club by
// club (the tables are under tenant row-level security). The activities
// stay. Event registrations follow the same retention, and answers to
// sensitive questions go 30 days after the event (P1.6,
// app.purge_expired_event_data). Record history keeps its own retention
// (ADR 0017).

import { type Database, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

const JOB = "attendance:retention";

export async function deleteExpiredAttendance(db: Database): Promise<{
  responses: number;
  attendance: number;
  registrations: number;
  sensitiveAnswers: number;
}> {
  const { rows: clubs } = await db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM public.clubs`),
  );
  const deleted = { responses: 0, attendance: 0, registrations: 0, sensitiveAnswers: 0 };
  for (const { id: clubId } of clubs) {
    await db.withSystem(JOB, { clubId }, async (tx) => {
      const { rows } = await tx.execute<{ responses: string; attendance: string }>(
        sql`SELECT * FROM app.purge_expired_attendance()`,
      );
      deleted.responses += Number(rows[0]?.responses ?? 0);
      deleted.attendance += Number(rows[0]?.attendance ?? 0);
      const { rows: events } = await tx.execute<{
        registrations: string;
        sensitive_answers: string;
      }>(sql`SELECT * FROM app.purge_expired_event_data()`);
      deleted.registrations += Number(events[0]?.registrations ?? 0);
      deleted.sensitiveAnswers += Number(events[0]?.sensitive_answers ?? 0);
    });
  }
  return deleted;
}

export function attendanceRetentionTask(db: Database): Task {
  return async (_payload, helpers) => {
    const deleted = await deleteExpiredAttendance(db);
    helpers.logger.info("attendance retention", deleted);
  };
}
