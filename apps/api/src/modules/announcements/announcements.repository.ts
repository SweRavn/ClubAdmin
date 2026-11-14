// SPDX-License-Identifier: AGPL-3.0-only
// The announcements' tables (P2.3, migration 0044). Every query runs in the
// club's context (tenant RLS) and starts from the club, the group or the
// announcement (their indexes); audiences are checked in SQL
// (app.audience_includes, app.announcement_readable), never row by row.

import { sql, type Tx } from "@clubadmin/db";
import type { AnnouncementChannel, AnnouncementStatus } from "@clubadmin/shared";

export interface AnnouncementRow {
  id: string;
  clubId: string;
  clubName: string;
  groupId: string | null;
  groupName: string | null;
  audienceId: string | null;
  title: string;
  body: string;
  channels: AnnouncementChannel[];
  important: boolean;
  pinnedUntil: Date | null;
  expiresAt: Date | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  editedAt: Date | null;
  withdrawnAt: Date | null;
  createdByPersonId: string | null;
  read: boolean;
}

type RowSql = {
  id: string;
  club_id: string;
  club_name: string;
  group_id: string | null;
  group_name: string | null;
  audience_id: string | null;
  title: string;
  body: string;
  channels: AnnouncementChannel[];
  important: boolean;
  pinned_until: string | null;
  expires_at: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  edited_at: string | null;
  withdrawn_at: string | null;
  created_by_person_id: string | null;
  is_read: boolean;
};

const date = (v: string | null) => (v ? new Date(v) : null);

const toRow = (r: RowSql): AnnouncementRow => ({
  id: r.id,
  clubId: r.club_id,
  clubName: r.club_name,
  groupId: r.group_id,
  groupName: r.group_name,
  audienceId: r.audience_id,
  title: r.title,
  body: r.body,
  channels: r.channels,
  important: r.important,
  pinnedUntil: date(r.pinned_until),
  expiresAt: date(r.expires_at),
  scheduledAt: date(r.scheduled_at),
  sentAt: date(r.sent_at),
  editedAt: date(r.edited_at),
  withdrawnAt: date(r.withdrawn_at),
  createdByPersonId: r.created_by_person_id,
  read: r.is_read,
});

export function statusOf(row: AnnouncementRow): AnnouncementStatus {
  if (row.withdrawnAt) return "withdrawn";
  if (row.sentAt) return "sent";
  if (row.scheduledAt) return "scheduled";
  return "draft";
}

const COLUMNS = (personId: string) => sql`
  a.id, a.club_id, a.group_id, a.audience_id,
  -- Names by primary key, row by row: a join would let the planner scan the clubs and groups.
  (SELECT cl.name FROM public.clubs cl WHERE cl.id = a.club_id) AS club_name,
  (SELECT g.name FROM public.groups g WHERE g.id = a.group_id) AS group_name,
  a.title, a.body, a.channels, a.important, a.pinned_until::text, a.expires_at::text,
  a.scheduled_at::text, a.sent_at::text, a.edited_at::text, a.withdrawn_at::text,
  a.created_by_person_id, app.announcement_read(a.id, ${personId}::uuid) AS is_read`;

const FROM = sql`FROM public.announcements a`;

export async function insertAnnouncement(
  tx: Tx,
  input: {
    clubId: string;
    groupId: string | null;
    audienceId: string;
    title: string;
    body: string;
    channels: readonly AnnouncementChannel[];
    important: boolean;
    pinnedUntil: string | null;
    expiresAt: string | null;
    scheduledAt: string | null;
    createdBy: string;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.announcements (club_id, group_id, audience_id, title, body, channels,
      important, pinned_until, expires_at, scheduled_at, created_by_person_id)
    VALUES (${input.clubId}, ${input.groupId}, ${input.audienceId}, ${input.title}, ${input.body},
      ${`{${input.channels.join(",")}}`}::text[], ${input.important},
      ${input.pinnedUntil}::timestamptz, ${input.expiresAt}::timestamptz,
      ${input.scheduledAt}::timestamptz, ${input.createdBy})
    RETURNING id`);
  return rows[0]!.id;
}

export async function findAnnouncement(
  tx: Tx,
  id: string,
  personId: string,
  lock = false,
): Promise<AnnouncementRow | null> {
  const { rows } = await tx.execute<RowSql>(sql`
    SELECT ${COLUMNS(personId)} ${FROM} WHERE a.id = ${id}::uuid
    ${lock ? sql`FOR UPDATE OF a` : sql``}`);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface AnnouncementChanges {
  title?: string;
  body?: string;
  channels?: readonly AnnouncementChannel[];
  important?: boolean;
  pinnedUntil?: string | null;
  expiresAt?: string | null;
  scheduledAt?: string | null;
  sent?: true;
  edited?: true;
}

export async function updateAnnouncement(
  tx: Tx,
  id: string,
  changes: AnnouncementChanges,
): Promise<void> {
  const sets = [
    changes.title !== undefined ? sql`title = ${changes.title}` : null,
    changes.body !== undefined ? sql`body = ${changes.body}` : null,
    changes.channels !== undefined
      ? sql`channels = ${`{${changes.channels.join(",")}}`}::text[]`
      : null,
    changes.important !== undefined ? sql`important = ${changes.important}` : null,
    changes.pinnedUntil !== undefined
      ? sql`pinned_until = ${changes.pinnedUntil}::timestamptz`
      : null,
    changes.expiresAt !== undefined ? sql`expires_at = ${changes.expiresAt}::timestamptz` : null,
    changes.scheduledAt !== undefined
      ? sql`scheduled_at = ${changes.scheduledAt}::timestamptz`
      : null,
    changes.sent ? sql`sent_at = now()` : null,
    changes.edited ? sql`edited_at = now()` : null,
  ].filter((s) => s !== null);
  if (sets.length === 0) return;
  await tx.execute(
    sql`UPDATE public.announcements SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`,
  );
}

export async function withdraw(tx: Tx, id: string, by: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.announcements SET withdrawn_at = now(), withdrawn_by_person_id = ${by}
    WHERE id = ${id}::uuid AND withdrawn_at IS NULL`);
}

export async function deleteAnnouncement(tx: Tx, id: string): Promise<string | null> {
  const { rows } = await tx.execute<{ audience_id: string }>(sql`
    DELETE FROM public.announcements WHERE id = ${id}::uuid RETURNING audience_id`);
  return rows[0]?.audience_id ?? null;
}

/**
 * A group's board: its sent announcements the person reads (and, for those
 * who send to it, its drafts and scheduled ones), not expired; pinned ones
 * or the newest after the cursor ((sent_at or created_at, id) descending).
 */
export async function groupBoard(
  tx: Tx,
  input: {
    groupId: string;
    personId: string;
    manage: boolean;
    pinned: boolean;
    cursor: string | null;
    limit: number;
  },
): Promise<AnnouncementRow[]> {
  const after = input.cursor
    ? sql`AND (a.sent_at, a.id) < (SELECT c.sent_at, c.id FROM public.announcements c
              WHERE c.id = ${input.cursor}::uuid)`
    : sql``;
  const { rows } = await tx.execute<RowSql>(sql`
    SELECT ${COLUMNS(input.personId)} ${FROM}
    WHERE a.group_id = ${input.groupId}::uuid AND a.sent_at IS NOT NULL AND a.withdrawn_at IS NULL
      AND (a.expires_at IS NULL OR a.expires_at > now())
      ${input.pinned ? sql`AND a.pinned_until > now()` : after}
      ${input.manage ? sql`` : sql`AND app.audience_includes(a.audience_id, ${input.personId}::uuid)`}
    ORDER BY a.sent_at DESC, a.id DESC
    LIMIT ${input.limit}`);
  return rows.map(toRow);
}

/**
 * The club's archive (or a group's, for its senders): every announcement,
 * drafts and withdrawn ones too, newest first by creation.
 */
export async function archive(
  tx: Tx,
  input: {
    clubId: string;
    groupId: string | null;
    personId: string;
    cursor: string | null;
    limit: number;
  },
): Promise<AnnouncementRow[]> {
  const after = input.cursor
    ? sql`AND (a.created_at, a.id) < (SELECT c.created_at, c.id FROM public.announcements c
              WHERE c.id = ${input.cursor}::uuid)`
    : sql``;
  const scope = input.groupId ? sql`AND a.group_id = ${input.groupId}::uuid` : sql``;
  const { rows } = await tx.execute<RowSql>(sql`
    SELECT ${COLUMNS(input.personId)} ${FROM}
    WHERE a.club_id = ${input.clubId}::uuid ${scope} ${after}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${input.limit}`);
  return rows.map(toRow);
}

/** "Anslagstavlan" across the caller's clubs (app.my_announcements; outside a club). */
export async function myBoard(
  tx: Tx,
  input: { cursor: string | null; limit: number; pinned: boolean },
): Promise<AnnouncementRow[]> {
  const { rows } = await tx.execute<Omit<RowSql, "id"> & { announcement_id: string }>(sql`
    SELECT announcement_id, club_id, club_name, group_id, group_name, NULL::uuid AS audience_id,
      title, body, channels, important, pinned_until::text, expires_at::text,
      NULL::text AS scheduled_at, sent_at::text, edited_at::text, NULL::text AS withdrawn_at,
      created_by_person_id, is_read
    FROM app.my_announcements(${input.cursor}::uuid, ${input.limit}, ${input.pinned})`);
  return rows.map((r) => toRow({ ...r, id: r.announcement_id }));
}

/** Marks an announcement read, and its notice in the inbox. */
export async function markRead(
  tx: Tx,
  clubId: string,
  announcementId: string,
  personId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.announcement_reads (club_id, announcement_id, person_id)
    VALUES (${clubId}, ${announcementId}, ${personId})
    ON CONFLICT (announcement_id, person_id) DO NOTHING`);
  await tx.execute(sql`
    UPDATE public.notifications SET read_at = now()
    WHERE recipient_person_id = ${personId}::uuid
      AND dedupe_key = ${`announcement:${announcementId}`} AND read_at IS NULL`);
}

/** People an audience (given as entries) reaches, with an address and with the app. */
export async function reach(
  tx: Tx,
  clubId: string,
  entries: unknown,
): Promise<{ recipients: number; withEmail: number; withApp: number }> {
  const { rows } = await tx.execute<{ people: number; with_email: number; with_app: number }>(sql`
    SELECT people, with_email, with_app FROM app.entries_reach(${clubId}::uuid,
      ${JSON.stringify(entries)}::jsonb)`);
  const r = rows[0]!;
  return { recipients: r.people, withEmail: r.with_email, withApp: r.with_app };
}

/** Announcement emails sent in the club in the last 24 hours (the per-club limit). */
export async function emailsLastDay(tx: Tx, clubId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT coalesce(sum(a.email_count), 0)::int AS n FROM public.announcements a
    WHERE a.club_id = ${clubId}::uuid AND a.email_count IS NOT NULL
      AND a.sent_at > now() - interval '24 hours'`);
  return rows[0]!.n;
}

export interface DeliveryCounts {
  queued: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * What happened to an announcement: the recipients counted when sent, the
 * reads, and its notices' deliveries per channel (a system read: the
 * notices are the recipients' own).
 */
export async function recipients(
  tx: Tx,
  announcementId: string,
): Promise<{
  recipients: number | null;
  read: number;
  push: DeliveryCounts;
  email: DeliveryCounts;
}> {
  const { rows: head } = await tx.execute<{ recipients: number | null; read: number }>(sql`
    SELECT a.recipient_count AS recipients,
      (SELECT count(*)::int FROM public.announcement_reads r
       WHERE r.announcement_id = a.id) AS read
    FROM public.announcements a WHERE a.id = ${announcementId}::uuid`);
  const { rows } = await tx.execute<{ channel: "email" | "push"; status: string; n: number }>(sql`
    SELECT d.channel, d.status, count(*)::int AS n
    FROM public.notifications n
    JOIN public.notification_deliveries d ON d.notification_id = n.id
    WHERE n.subject_type = 'announcement' AND n.subject_id = ${announcementId}::uuid
    GROUP BY d.channel, d.status`);
  const counts = (channel: "email" | "push"): DeliveryCounts => {
    const of = (status: string) =>
      rows.filter((r) => r.channel === channel && r.status === status).reduce((s, r) => s + r.n, 0);
    return {
      queued: of("queued") + of("held"),
      sent: of("sent"),
      skipped: of("skipped"),
      failed: of("failed"),
    };
  };
  return {
    recipients: head[0]?.recipients ?? null,
    read: head[0]?.read ?? 0,
    push: counts("push"),
    email: counts("email"),
  };
}
