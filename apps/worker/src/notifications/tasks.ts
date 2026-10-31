// SPDX-License-Identifier: AGPL-3.0-only
// Scheduled and debounced notification work (P1.7, ADR 0039):
// - `notifications:fanout`: debounced notices (an activity's or series'
//   changes, a late "not coming"), reading the state when they run;
// - `notifications:response_reminders` (every 15 minutes): 24 hours before
//   an activity's deadline (or start), those who have not answered;
// - `notifications:event_reminders` (every 15 minutes): 24 hours before an
//   event's sign-up closes, its audience who have not signed up;
// - `notifications:retention` (daily): notices after 90 days, deliveries
//   after 30, devices 90 days after they were last seen.

import { type Database, sql, type Tx } from "@clubadmin/db";
import { NOTICE_HORIZON_DAYS, NOTICE_LEAD_HOURS, z } from "@clubadmin/shared";
import type { Task } from "graphile-worker";

import { type Channels, createNotices, type Notice, uuidArray } from "./fanout.ts";
import {
  activityFacts,
  activityParams,
  eventAudience,
  eventFacts,
  eventParams,
  leaders,
  participants,
  RIGHTS,
  useClub,
  withGuardians,
} from "./recipients.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface NotificationTaskDependencies {
  db: Database;
  channels: Channels;
  now?: () => Date;
}

const FanoutPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity"), clubId: z.uuid(), activityId: z.uuid() }),
  z.object({ kind: z.literal("series"), clubId: z.uuid(), seriesId: z.uuid() }),
  z.object({ kind: z.literal("late"), clubId: z.uuid(), activityId: z.uuid(), personId: z.uuid() }),
]);

export function fanoutTask(deps: NotificationTaskDependencies): Task {
  return async (payload) => {
    const job = FanoutPayload.parse(payload);
    const at = deps.now?.() ?? new Date();
    await deps.db.withSystem("notifications:fanout", {}, async (tx) => {
      const notices =
        job.kind === "activity"
          ? await activityChanged(tx, job.clubId, job.activityId, at)
          : job.kind === "series"
            ? await seriesChanged(tx, job.clubId, job.seriesId, at)
            : await lateDecline(tx, job.clubId, job.activityId, job.personId, at);
      await createNotices(tx, notices, { channels: deps.channels, now: at });
    });
  };
}

/** An activity changed (time, place, title, …): its participants, once per version. */
async function activityChanged(
  tx: Tx,
  clubId: string,
  activityId: string,
  at: Date,
): Promise<Notice[]> {
  const a = await activityFacts(tx, clubId, activityId);
  if (!a || a.status !== "scheduled") return [];
  if (a.startsAt.getTime() <= at.getTime()) return [];
  if (a.startsAt.getTime() > at.getTime() + NOTICE_HORIZON_DAYS * DAY_MS) return [];
  const people = await withGuardians(tx, await participants(tx, a.id), RIGHTS.schedule);
  return [...people].map(([recipient, about]) => ({
    recipientPersonId: recipient,
    clubId,
    type: "activity.moved",
    subjectType: "activity",
    subjectId: a.id,
    about,
    params: activityParams(a),
    dedupeKey: `activity:${a.id}:seq:${a.sequence}`,
    dueAt: a.startsAt,
  }));
}

/** A series changed: the members of its groups, if a session is within the horizon. */
async function seriesChanged(
  tx: Tx,
  clubId: string,
  seriesId: string,
  at: Date,
): Promise<Notice[]> {
  await useClub(tx, clubId);
  const { rows } = await tx.execute<{
    title: string;
    updated_at: string;
    next_start: string | null;
    group_name: string | null;
    time_zone: string;
  }>(sql`
    SELECT s.title, s.updated_at, c.time_zone,
      (SELECT min(a.starts_at) FROM public.activities a
       WHERE a.series_id = s.id AND a.status = 'scheduled' AND a.starts_at > ${at.toISOString()}::timestamptz) AS next_start,
      (SELECT g.name FROM public.activity_series_groups sg JOIN public.groups g ON g.id = sg.group_id
       WHERE sg.series_id = s.id ORDER BY g.name LIMIT 1) AS group_name
    FROM public.activity_series s JOIN public.clubs c ON c.id = s.club_id WHERE s.id = ${seriesId}`);
  const s = rows[0];
  if (!s?.next_start) return [];
  const next = new Date(s.next_start);
  if (next.getTime() > at.getTime() + NOTICE_HORIZON_DAYS * DAY_MS) return [];
  const { rows: members } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT gm.person_id FROM public.activity_series_groups sg
    JOIN public.group_memberships gm ON gm.group_id = sg.group_id
      AND gm.function = 'member' AND gm.valid_to IS NULL
    WHERE sg.series_id = ${seriesId}`);
  const people = await withGuardians(
    tx,
    members.map((m) => m.person_id),
    RIGHTS.schedule,
  );
  return [...people].map(([recipient, about]) => ({
    recipientPersonId: recipient,
    clubId,
    type: "series.changed",
    subjectType: "series",
    subjectId: seriesId,
    about,
    params: {
      title: s.title,
      group: s.group_name,
      startsAt: next.toISOString(),
      timeZone: s.time_zone,
    },
    dedupeKey: `series:${seriesId}:${Date.parse(s.updated_at)}`,
    dueAt: next,
  }));
}

/** "Not coming" after the deadline or within 24 hours, still so after five minutes: the leaders. */
async function lateDecline(
  tx: Tx,
  clubId: string,
  activityId: string,
  personId: string,
  at: Date,
): Promise<Notice[]> {
  const a = await activityFacts(tx, clubId, activityId);
  if (!a || a.status !== "scheduled" || a.startsAt.getTime() <= at.getTime()) return [];
  const { rows } = await tx.execute<{
    status: string;
    responded_at: string;
    responded_by_person_id: string;
  }>(sql`
    SELECT status, responded_at, responded_by_person_id FROM public.activity_responses
    WHERE activity_id = ${activityId} AND person_id = ${personId}`);
  const answer = rows[0];
  if (answer?.status !== "not_attending") return [];
  const recipients = (await leaders(tx, clubId, activityId)).filter(
    // A leader who set the answer knows already.
    (id) => id !== answer.responded_by_person_id && id !== personId,
  );
  return recipients.map((recipient) => ({
    recipientPersonId: recipient,
    clubId,
    type: "response.late_decline",
    subjectType: "activity",
    subjectId: a.id,
    about: [personId],
    params: activityParams(a),
    dedupeKey: `late:${a.id}:${personId}:${Date.parse(answer.responded_at)}`,
    dueAt: a.startsAt,
  }));
}

/** 24 hours before an answer is due, those who have not answered (via those who may answer). */
export function responseRemindersTask(deps: NotificationTaskDependencies): Task {
  return async () => {
    const at = deps.now?.() ?? new Date();
    for (const clubId of await clubIds(deps.db)) {
      await deps.db.withSystem("notifications:response_reminders", { clubId }, async (tx) => {
        // The partial index activities_reminder_idx, in each club (tenant row-level security).
        const { rows } = await tx.execute<{ id: string; club_id: string }>(reminderScanQuery(at));
        for (const row of rows) {
          const a = await activityFacts(tx, row.club_id, row.id);
          if (!a) continue;
          const roster = await participants(tx, a.id);
          if (roster.length === 0) continue;
          const { rows: answered } = await tx.execute<{ person_id: string }>(sql`
          SELECT person_id FROM public.activity_responses
          WHERE club_id = ${a.clubId} AND activity_id = ${a.id}
            AND person_id = ANY (${uuidArray(roster)}::uuid[])`);
          const done = new Set(answered.map((r) => r.person_id));
          const people = await withGuardians(
            tx,
            roster.filter((id) => !done.has(id)),
            RIGHTS.answer,
          );
          await createNotices(
            tx,
            [...people].map(([recipient, about]) => ({
              recipientPersonId: recipient,
              clubId: a.clubId,
              type: "response.reminder",
              subjectType: "activity",
              subjectId: a.id,
              about,
              params: activityParams(a),
              dedupeKey: `reminder:${a.id}`,
              dueAt: a.respondBy ?? a.startsAt,
            })),
            { channels: deps.channels, now: at },
          );
        }
      });
    }
  };
}

/** The clubs (system read); scheduled scans run club by club. */
async function clubIds(db: Database): Promise<string[]> {
  const { rows } = await db.withSystem("notifications:clubs", {}, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM public.clubs WHERE status <> 'archived'`),
  );
  return rows.map((r) => r.id);
}

/** Requested activities of the club (its RLS context) whose answer is due within the lead time. */
export const reminderScanQuery = (at: Date) => sql`
        SELECT a.id, a.club_id FROM public.activities a
        WHERE a.response_mode = 'requested' AND a.status = 'scheduled'
          AND coalesce(a.respond_by, a.starts_at) > ${at.toISOString()}::timestamptz
          AND coalesce(a.respond_by, a.starts_at) <= ${new Date(at.getTime() + NOTICE_LEAD_HOURS * HOUR_MS).toISOString()}::timestamptz
          AND a.starts_at > ${at.toISOString()}::timestamptz
        LIMIT 2000`;

/** 24 hours before sign-up closes, the audience who have not signed up (via those who may sign up). */
export function eventRemindersTask(deps: NotificationTaskDependencies): Task {
  return async () => {
    const at = deps.now?.() ?? new Date();
    for (const clubId of await clubIds(deps.db)) {
      await deps.db.withSystem("notifications:event_reminders", { clubId }, async (tx) => {
        const { rows } = await tx.execute<{ id: string; club_id: string }>(sql`
        SELECT e.id, e.club_id FROM public.events e
        WHERE e.status = 'published'
          AND (e.registration_opens_at IS NULL OR e.registration_opens_at <= ${at.toISOString()}::timestamptz)
          AND e.registration_closes_at > ${at.toISOString()}::timestamptz
          AND e.registration_closes_at <= ${new Date(at.getTime() + NOTICE_LEAD_HOURS * HOUR_MS).toISOString()}::timestamptz
        LIMIT 500`);
        for (const row of rows) {
          const e = await eventFacts(tx, row.club_id, row.id);
          if (!e) continue;
          const audience = await eventAudience(tx, e);
          const { rows: signed } = await tx.execute<{ person_id: string }>(sql`
          SELECT person_id FROM public.event_registrations
          WHERE event_id = ${e.id} AND status IN ('confirmed', 'waitlisted', 'offered', 'cancelled', 'declined')`);
          const done = new Set(signed.map((r) => r.person_id));
          const people = await withGuardians(
            tx,
            audience.filter((id) => !done.has(id)),
            RIGHTS.events,
          );
          await createNotices(
            tx,
            [...people].map(([recipient, about]) => ({
              recipientPersonId: recipient,
              clubId: e.clubId,
              type: "event.signup.reminder",
              subjectType: "event",
              subjectId: e.id,
              about,
              params: eventParams(e),
              dedupeKey: `event:${e.id}:reminder`,
              dueAt: e.closesAt,
            })),
            { channels: deps.channels, now: at },
          );
        }
      });
    }
  };
}

/** What retention deletes (each on its own index: created_at, created_at, account/last seen). */
export function retentionQueries(at: Date) {
  const before = (days: number) => new Date(at.getTime() - days * DAY_MS).toISOString();
  return {
    deliveries: sql`
        DELETE FROM public.notification_deliveries WHERE created_at < ${before(30)}::timestamptz`,
    notices: sql`
        DELETE FROM public.notifications WHERE created_at < ${before(90)}::timestamptz`,
    devices: sql`
        DELETE FROM public.push_devices
        WHERE last_seen_at < ${before(90)}::timestamptz OR disabled_at < ${before(7)}::timestamptz`,
  };
}

/** Retention (decision 9): notices 90 days, deliveries 30 days, devices 90 days after last seen. */
export function notificationsRetentionTask(db: Database, now?: () => Date): Task {
  return async (_payload, helpers) => {
    const at = now?.() ?? new Date();
    const result = await db.withSystem("notifications:retention", {}, async (tx) => {
      const queries = retentionQueries(at);
      const deliveries = await tx.execute(queries.deliveries);
      const notices = await tx.execute(queries.notices);
      const devices = await tx.execute(queries.devices);
      return {
        deliveries: deliveries.rowCount ?? 0,
        notices: notices.rowCount ?? 0,
        devices: devices.rowCount ?? 0,
      };
    });
    helpers.logger.info("notification retention", result);
  };
}
