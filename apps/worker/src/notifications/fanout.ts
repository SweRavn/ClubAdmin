// SPDX-License-Identifier: AGPL-3.0-only
// Creating notices (P1.7, ADR 0039): one row per recipient and dedupe key
// (a redelivered event creates nothing), and its deliveries by the
// recipient's settings, devices and the server's channels:
// - push to every active device of the account, held during quiet hours
//   unless what it is about comes before they end (plus two hours);
// - email by the category's mode ("always", "no_app": only without an app
//   with push, "never"; mandatory types always). Emails go into the daily
//   email at 17:00 local time, except immediate types and notices about
//   something that starts (or is due) before the next daily email plus 24
//   hours: those are sent at once, so every notice reaches the person at
//   least 24 hours ahead, or at once when it comes later than that.
// Runs in the caller's transaction (system context); IDs only in payloads.

import { sql, type Tx } from "@clubadmin/db";
import {
  DIGEST_LOCAL_TIME,
  effectiveSettings,
  localDate,
  localTime,
  NOTICE_LEAD_HOURS,
  type NotificationType,
  notificationTypeInfo,
  zonedTime,
} from "@clubadmin/shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A held push is released anyway when what it is about starts within this after quiet hours end. */
const QUIET_MARGIN_MS = 2 * HOUR_MS;
const MAX_ABOUT = 10;

export interface Notice {
  recipientPersonId: string;
  clubId: string | null;
  type: NotificationType;
  subjectType: string;
  subjectId: string | null;
  /** The people it is about (wards, a player); never the recipient. */
  about: readonly string[];
  /** IDs, enum values, counts, times, titles of activities or events; never people's names. */
  params: Record<string, unknown>;
  dedupeKey: string;
  /** When what it is about happens (start or deadline). */
  dueAt?: Date | null;
}

export interface Channels {
  /** SMTP configured. */
  email: boolean;
  /** A push provider configured. */
  push: boolean;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The next daily email (17:00 in the time zone) after `now`. */
export function nextDigest(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  const at = zonedTime(today, DIGEST_LOCAL_TIME, timeZone);
  if (at && at.getTime() > now.getTime()) return at;
  return (
    zonedTime(addDays(today, 1), DIGEST_LOCAL_TIME, timeZone) ?? new Date(now.getTime() + DAY_MS)
  );
}

/** The end of the quiet hours `now` falls in, or null outside them. */
export function quietUntil(
  now: Date,
  timeZone: string,
  quiet: { from: string; to: string } | null,
): Date | null {
  if (!quiet || quiet.from === quiet.to) return null;
  const t = localTime(now, timeZone);
  const overnight = quiet.from > quiet.to;
  const inside = overnight ? t >= quiet.from || t < quiet.to : t >= quiet.from && t < quiet.to;
  if (!inside) return null;
  const today = localDate(now, timeZone);
  const day = overnight && t >= quiet.from ? addDays(today, 1) : today;
  return zonedTime(day, quiet.to, timeZone);
}

/** Whether an email about something due at `dueAt` must go at once rather than in the daily email. */
export function emailAtOnce(
  type: NotificationType,
  dueAt: Date | null | undefined,
  digestAt: Date,
) {
  if (notificationTypeInfo(type).immediate) return true;
  return dueAt != null && dueAt.getTime() - NOTICE_LEAD_HOURS * HOUR_MS <= digestAt.getTime();
}

type RecipientRow = {
  person_id: string;
  has_email: boolean;
  settings: unknown;
  time_zone: string | null;
  devices: string[] | null;
};

/** Merges notices to the same recipient and key (one notice listing all wards concerned). */
function merge(notices: readonly Notice[]): Notice[] {
  const byKey = new Map<string, Notice>();
  for (const n of notices) {
    const key = `${n.recipientPersonId}|${n.dedupeKey}`;
    const seen = byKey.get(key);
    const about = [...new Set([...(seen?.about ?? []), ...n.about])]
      .filter((id) => id !== n.recipientPersonId)
      .slice(0, MAX_ABOUT);
    byKey.set(key, { ...(seen ?? n), about });
  }
  return [...byKey.values()];
}

/**
 * Inserts the notices and their deliveries and wakes the delivery task.
 * Recipients without an account get nothing. Returns the notices created.
 */
export async function createNotices(
  tx: Tx,
  input: readonly Notice[],
  options: { channels: Channels; now: Date },
): Promise<number> {
  const notices = merge(input);
  if (notices.length === 0) return 0;
  const personIds = [...new Set(notices.map((n) => n.recipientPersonId))];
  const clubIds = [...new Set(notices.map((n) => n.clubId).filter((c): c is string => c !== null))];
  const { rows: recipients } = await tx.execute<RecipientRow>(sql`
    SELECT a.person_id, a.email_verified_at IS NOT NULL AS has_email,
      a.notification_settings AS settings, a.time_zone,
      (SELECT array_agg(d.id) FROM public.push_devices d
       WHERE d.account_id = a.id AND d.disabled_at IS NULL) AS devices
    FROM public.accounts a
    WHERE a.person_id = ANY (${uuidArray(personIds)}::uuid[])`);
  const { rows: zones } = clubIds.length
    ? await tx.execute<{ id: string; time_zone: string }>(sql`
        SELECT id, time_zone FROM public.clubs WHERE id = ANY (${uuidArray(clubIds)}::uuid[])`)
    : { rows: [] };
  const clubZone = new Map(zones.map((z) => [z.id, z.time_zone]));
  const byPerson = new Map(recipients.map((r) => [r.person_id, r]));
  const wanted = notices.filter((n) => byPerson.has(n.recipientPersonId));
  if (wanted.length === 0) return 0;

  const { rows: created } = await tx.execute<{
    id: string;
    recipient_person_id: string;
    dedupe_key: string;
  }>(sql`
    INSERT INTO public.notifications
      (recipient_person_id, club_id, category, type, subject_type, subject_id, about_person_ids, params, dedupe_key)
    SELECT n.recipient_person_id, n.club_id, n.category, n.type, n.subject_type, n.subject_id,
      n.about_person_ids, n.params, n.dedupe_key
    FROM jsonb_to_recordset(${JSON.stringify(
      wanted.map((n) => ({
        recipient_person_id: n.recipientPersonId,
        club_id: n.clubId,
        category: notificationTypeInfo(n.type).category,
        type: n.type,
        subject_type: n.subjectType,
        subject_id: n.subjectId,
        about_person_ids: n.about,
        params: n.params,
        dedupe_key: n.dedupeKey,
      })),
    )}::jsonb) AS n(recipient_person_id uuid, club_id uuid, category text, type text,
      subject_type text, subject_id uuid, about_person_ids uuid[], params jsonb, dedupe_key text)
    ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING
    RETURNING id, recipient_person_id, dedupe_key`);
  if (created.length === 0) return 0;

  const byKey = new Map(wanted.map((n) => [`${n.recipientPersonId}|${n.dedupeKey}`, n]));
  const deliveries: {
    notification_id: string;
    channel: "email" | "push";
    push_device_id: string | null;
    status: "queued" | "held";
    digest: boolean;
    send_after: string;
  }[] = [];
  const now = options.now;
  for (const row of created) {
    const notice = byKey.get(`${row.recipient_person_id}|${row.dedupe_key}`)!;
    const recipient = byPerson.get(row.recipient_person_id)!;
    const info = notificationTypeInfo(notice.type);
    const settings = effectiveSettings(recipient.settings);
    const category = settings.categories[info.category];
    const zone =
      recipient.time_zone ??
      (notice.clubId ? clubZone.get(notice.clubId) : undefined) ??
      "Europe/Stockholm";
    const devices = recipient.devices ?? [];
    const pushes = options.channels.push && category.push && devices.length > 0;
    if (pushes) {
      const quietEnd = quietUntil(now, zone, settings.quietHours);
      const urgent =
        quietEnd !== null &&
        notice.dueAt != null &&
        notice.dueAt.getTime() <= quietEnd.getTime() + QUIET_MARGIN_MS;
      for (const device of devices) {
        const held = quietEnd !== null && !urgent;
        deliveries.push({
          notification_id: row.id,
          channel: "push",
          push_device_id: device,
          status: held ? "held" : "queued",
          digest: false,
          send_after: (held ? quietEnd : now).toISOString(),
        });
      }
    }
    const mode = info.mandatoryEmail ? "always" : category.email;
    const emails =
      options.channels.email &&
      recipient.has_email &&
      (mode === "always" || (mode === "no_app" && !pushes));
    if (emails) {
      const digestAt = nextDigest(now, zone);
      const atOnce = emailAtOnce(notice.type, notice.dueAt, digestAt);
      deliveries.push({
        notification_id: row.id,
        channel: "email",
        push_device_id: null,
        status: atOnce ? "queued" : "held",
        digest: !atOnce,
        send_after: (atOnce ? now : digestAt).toISOString(),
      });
    }
  }
  if (deliveries.length > 0) {
    await tx.execute(sql`
      INSERT INTO public.notification_deliveries
        (notification_id, channel, push_device_id, status, digest, send_after)
      SELECT d.notification_id, d.channel, d.push_device_id, d.status, d.digest, d.send_after
      FROM jsonb_to_recordset(${JSON.stringify(deliveries)}::jsonb) AS d(notification_id uuid,
        channel text, push_device_id uuid, status text, digest boolean, send_after timestamptz)`);
    if (deliveries.some((d) => d.status === "queued")) await wakeDelivery(tx);
  }
  return created.length;
}

/** Runs the delivery task at once (one queued job at a time). */
export async function wakeDelivery(tx: Tx): Promise<void> {
  await tx.execute(sql`
    SELECT graphile_worker.add_job('notifications:deliver', '{}'::json,
      job_key := 'notifications:deliver', max_attempts := 5)`);
}

/** Runs a debounced fan-out after `delayMs`; a later call with the same key moves it (debounce). */
export async function debounce(
  tx: Tx,
  key: string,
  payload: Record<string, string>,
  delayMs: number,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    SELECT graphile_worker.add_job('notifications:fanout', ${JSON.stringify(payload)}::json,
      run_at := ${new Date(now.getTime() + delayMs).toISOString()}::timestamptz,
      job_key := ${key}, job_key_mode := 'replace', max_attempts := 5)`);
}

export const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;
