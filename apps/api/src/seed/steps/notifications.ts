// SPDX-License-Identifier: AGPL-3.0-only
// Demo notifications (P1.7, ADR 0039; docs/seed-data.md). In a running
// system the worker creates notices from domain events; the seed has no
// worker, so it writes the personas' inboxes directly in system context,
// with the params the worker would store (IDs, times, titles; never names):
// - Anna: next week's cancelled F2017 Tuesday (unread), Oskar called up for
//   an IKN P2012 session (unread), an answer reminder for F2017 (read), and
//   a phone with push (fake provider) when NOTIFICATION_TOKEN_KEY is set.
// - Mikael: the same cancellation; email "never" for the schedule and
//   quiet hours 22:00–06:30.
// - Erik: a late "not coming" for Elsa.
// - Liam (English): no longer called up for a session of his group.
// - Lars (Norwegian): a moved FIL session.
// - Henrik: his join request decided (approved), if he has one.
// Gunilla gets no schedule notices (view_schedule only); Nils and Bo have
// no account and get nothing. The seed's own domain events are history,
// not news: they are marked as handled by the worker's `notifications`
// handler, so starting the worker sends no notices, emails or pushes for
// them.

import { sql, type Tx } from "@clubadmin/db";
import { hashPushToken, sealPushToken } from "@clubadmin/server-kit/notifications";
import { type NotificationType, notificationTypeInfo, uuidv7 } from "@clubadmin/shared";

import type { DemoStep } from "../environment.ts";

interface Facts {
  id: string;
  clubId: string;
  title: string;
  startsAt: string;
  timeZone: string;
  group: string | null;
}

type ActivityRow = {
  id: string;
  club_id: string;
  title: string;
  starts_at: string | Date;
  time_zone: string;
  group_name: string | null;
};

const iso = (value: string | Date) => new Date(value).toISOString();

/** The first activity of a club matching `where` (SQL over `a`), ordered by start. */
async function activity(tx: Tx, clubId: string, where: ReturnType<typeof sql>) {
  await tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);
  const { rows } = await tx.execute<ActivityRow>(sql`
    SELECT a.id, a.club_id, a.title, a.starts_at, c.time_zone,
      (SELECT g.name FROM public.activity_groups ag JOIN public.groups g ON g.id = ag.group_id
       WHERE ag.activity_id = a.id ORDER BY g.name LIMIT 1) AS group_name
    FROM public.activities a JOIN public.clubs c ON c.id = a.club_id
    WHERE a.club_id = ${clubId} AND ${where}
    ORDER BY a.starts_at LIMIT 1`);
  const r = rows[0];
  return r
    ? ({
        id: r.id,
        clubId: r.club_id,
        title: r.title,
        startsAt: iso(r.starts_at),
        timeZone: r.time_zone,
        group: r.group_name,
      } satisfies Facts)
    : null;
}

interface SeedNotice {
  recipient: string;
  type: NotificationType;
  clubId: string | null;
  subjectType: string;
  subjectId: string | null;
  about?: string[];
  params: Record<string, unknown>;
  read?: boolean;
  createdAt: Date;
}

const activityParams = (a: Facts) => ({
  title: a.title,
  startsAt: a.startsAt,
  timeZone: a.timeZone,
  group: a.group,
});

export const notificationsDemoStep: DemoStep = {
  name: "notifications",
  async run(env, _data, core) {
    const id = (key: string) => {
      const value = core.ids.get(key);
      if (!value) throw new Error(`no id for ${key}`);
      return value;
    };
    const now = env.clock.now;
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    await env.db.withSystem("seed:notifications", {}, async (tx) => {
      const svk = id("svk");
      const ikn = id("ikn");
      const fil = id("fil");
      const future = sql`a.starts_at > now()`;
      const inGroup = (group: string) =>
        sql`EXISTS (SELECT 1 FROM public.activity_groups ag
          WHERE ag.activity_id = a.id AND ag.group_id = ${id(group)})`;
      const memberOf = (person: string) =>
        sql`EXISTS (SELECT 1 FROM public.activity_groups ag
          JOIN public.group_memberships gm ON gm.group_id = ag.group_id AND gm.valid_to IS NULL
          WHERE ag.activity_id = a.id AND gm.person_id = ${id(person)})`;

      const cancelled = await activity(
        tx,
        svk,
        sql`${future} AND a.status = 'cancelled' AND ${inGroup("svk-f2017")}`,
      );
      const requested = await activity(
        tx,
        svk,
        sql`${future} AND a.status = 'scheduled' AND a.response_mode = 'requested' AND ${inGroup("svk-f2017")}`,
      );
      const oskars = await activity(
        tx,
        ikn,
        sql`${future} AND a.status = 'scheduled' AND ${memberOf("oskar")}`,
      );
      const liams =
        (await activity(
          tx,
          svk,
          sql`${future} AND a.status = 'scheduled' AND ${memberOf("liam")}`,
        )) ??
        (await activity(
          tx,
          ikn,
          sql`${future} AND a.status = 'scheduled' AND ${memberOf("liam")}`,
        ));
      const fils = await activity(tx, fil, sql`${future} AND a.status = 'scheduled'`);

      const notices: SeedNotice[] = [];
      const about = (subject: Facts) => ({
        clubId: subject.clubId,
        subjectType: "activity",
        subjectId: subject.id,
        params: activityParams(subject),
      });
      if (cancelled) {
        for (const recipient of ["anna", "mikael"]) {
          notices.push({
            recipient,
            type: "activity.cancelled",
            ...about(cancelled),
            about: [id("elsa")],
            createdAt: ago(5),
          });
        }
      }
      if (oskars) {
        notices.push({
          recipient: "anna",
          type: "callup.added",
          ...about(oskars),
          about: [id("oskar")],
          createdAt: ago(20),
        });
      }
      if (requested) {
        notices.push({
          recipient: "anna",
          type: "response.reminder",
          ...about(requested),
          about: [id("elsa")],
          read: true,
          createdAt: ago(30),
        });
        notices.push({
          recipient: "erik",
          type: "response.late_decline",
          ...about(requested),
          about: [id("elsa")],
          createdAt: ago(2),
        });
      }
      if (liams) {
        notices.push({
          recipient: "liam",
          type: "callup.removed",
          ...about(liams),
          createdAt: ago(26),
        });
      }
      if (fils) {
        notices.push({
          recipient: "lars",
          type: "activity.moved",
          ...about(fils),
          params: { ...activityParams(fils), change: "time" },
          createdAt: ago(8),
        });
      }
      // A decided join request: Henrik's if decided, otherwise Gunilla's rejected one.
      for (const clubId of [svk, ikn, fil]) {
        await tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);
        const { rows } = await tx.execute<{ person_id: string; status: string }>(sql`
          SELECT person_id, status FROM public.join_requests
          WHERE club_id = ${clubId} AND status IN ('approved', 'rejected')
            AND person_id IN (${id("henrik")}, ${id("gunilla")})
          ORDER BY person_id = ${id("henrik")} DESC LIMIT 1`);
        const decided = rows[0];
        if (!decided) continue;
        notices.push({
          recipient: decided.person_id === id("henrik") ? "henrik" : "gunilla",
          type: "join_request.decided",
          clubId,
          subjectType: "club",
          subjectId: clubId,
          params: { status: decided.status },
          createdAt: ago(48),
        });
        break;
      }

      // Oldest first: IDs are time-ordered (UUIDv7) and the inbox is newest first by ID.
      notices.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
      for (const n of notices) {
        await tx.execute(sql`
          INSERT INTO public.notifications (id, recipient_person_id, club_id, category, type,
            subject_type, subject_id, about_person_ids, params, dedupe_key, read_at, created_at)
          SELECT ${uuidv7()}, a.person_id, ${n.clubId}, ${notificationTypeInfo(n.type).category},
            ${n.type}, ${n.subjectType}, ${n.subjectId},
            ${`{${(n.about ?? []).join(",")}}`}::uuid[], ${JSON.stringify(n.params)}::jsonb,
            ${`seed:${n.type}:${n.subjectId ?? ""}`},
            ${n.read ? n.createdAt.toISOString() : null}::timestamptz,
            ${n.createdAt.toISOString()}::timestamptz
          FROM public.accounts a WHERE a.person_id = ${id(n.recipient)}
          ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING`);
      }

      await tx.execute(sql`
        UPDATE public.accounts SET notification_settings = ${JSON.stringify({
          categories: { schedule: { email: "never" } },
          quietHours: { from: "22:00", to: "06:30" },
        })}::jsonb
        WHERE person_id = ${id("mikael")}`);

      // The seed's events are not news (see above).
      await tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`);

      // Anna's phone (the fake provider records pushes without sending).
      const key = process.env.NOTIFICATION_TOKEN_KEY;
      if (key && key.length >= 32) {
        const token = "ExponentPushToken[seed-anna-phone]";
        await tx.execute(sql`
          INSERT INTO public.push_devices (account_id, token_hash, token_sealed, platform, app_variant)
          SELECT a.id, ${hashPushToken(token)}, ${sealPushToken(key, token)}, 'ios', 'development'
          FROM public.accounts a WHERE a.person_id = ${id("anna")}
          ON CONFLICT (token_hash) DO NOTHING`);
      }
    });
  },
};
