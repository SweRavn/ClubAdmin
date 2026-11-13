// SPDX-License-Identifier: AGPL-3.0-only
// Child safety tables (P2.1 part B, migration 0040): reports, reads under the
// two-person rule and mutes. Every query runs in the club's context (tenant
// RLS) and starts from the club, the report or the person (their indexes).

import { sql, type Tx } from "@clubadmin/db";
import type { ChatReportOutcome, ChatReportReason, ChatReportStatus } from "@clubadmin/shared";

export interface ReportRow {
  id: string;
  clubId: string;
  chatId: string;
  messageId: string | null;
  reporterPersonId: string;
  reportedPersonId: string | null;
  reason: ChatReportReason;
  note: string | null;
  status: ChatReportStatus;
  outcome: ChatReportOutcome | null;
  outcomeNote: string | null;
  closedByPersonId: string | null;
  closedAt: Date | null;
  createdAt: Date;
  chatName: string | null;
  chatKind: "channel" | "direct";
  hasChildren: boolean;
}

export interface ReadRow {
  id: string;
  reportId: string;
  requestedByPersonId: string;
  confirmedByPersonId: string | null;
  confirmedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface MuteRow {
  id: string;
  personId: string;
  mutedByPersonId: string;
  reportId: string | null;
  until: Date;
}

type ReportSql = {
  id: string;
  club_id: string;
  chat_id: string;
  message_id: string | null;
  reporter_person_id: string;
  reported_person_id: string | null;
  reason: ChatReportReason;
  note: string | null;
  status: ChatReportStatus;
  outcome: ChatReportOutcome | null;
  outcome_note: string | null;
  closed_by_person_id: string | null;
  closed_at: string | null;
  created_at: string;
  chat_name: string | null;
  chat_kind: "channel" | "direct";
  has_children: boolean;
};

const toReport = (r: ReportSql): ReportRow => ({
  id: r.id,
  clubId: r.club_id,
  chatId: r.chat_id,
  messageId: r.message_id,
  reporterPersonId: r.reporter_person_id,
  reportedPersonId: r.reported_person_id,
  reason: r.reason,
  note: r.note,
  status: r.status,
  outcome: r.outcome,
  outcomeNote: r.outcome_note,
  closedByPersonId: r.closed_by_person_id,
  closedAt: r.closed_at ? new Date(r.closed_at) : null,
  createdAt: new Date(r.created_at),
  chatName: r.chat_name,
  chatKind: r.chat_kind,
  hasChildren: r.has_children,
});

const REPORT_COLUMNS = sql`
  r.id, r.club_id, r.chat_id, r.message_id, r.reporter_person_id, r.reported_person_id,
  r.reason, r.note, r.status, r.outcome, r.outcome_note, r.closed_by_person_id,
  r.closed_at::text, r.created_at::text, c.name AS chat_name, c.kind AS chat_kind,
  c.has_children`;

export async function insertReport(
  tx: Tx,
  input: {
    clubId: string;
    chatId: string;
    messageId: string | null;
    reporterPersonId: string;
    reportedPersonId: string | null;
    reason: ChatReportReason;
    note: string | null;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.chat_reports
      (club_id, chat_id, message_id, reporter_person_id, reported_person_id, reason, note)
    VALUES (${input.clubId}, ${input.chatId}, ${input.messageId}, ${input.reporterPersonId},
      ${input.reportedPersonId}, ${input.reason}, ${input.note})
    RETURNING id`);
  return rows[0]!.id;
}

/** The club's reports, newest first (chat_reports_club_idx); keyset on the ID. */
export async function reports(
  tx: Tx,
  clubId: string,
  page: { status: ChatReportStatus | null; cursor: string | null; limit: number },
): Promise<ReportRow[]> {
  const { rows } = await tx.execute<ReportSql>(sql`
    SELECT ${REPORT_COLUMNS}
    FROM public.chat_reports r JOIN public.chats c ON c.id = r.chat_id
    WHERE r.club_id = ${clubId}::uuid
      AND (${page.status}::text IS NULL OR r.status = ${page.status}::text)
      AND (${page.cursor}::uuid IS NULL OR r.id < ${page.cursor}::uuid)
    ORDER BY r.id DESC LIMIT ${page.limit}`);
  return rows.map(toReport);
}

export async function findReport(tx: Tx, reportId: string): Promise<ReportRow | null> {
  const { rows } = await tx.execute<ReportSql>(sql`
    SELECT ${REPORT_COLUMNS}
    FROM public.chat_reports r JOIN public.chats c ON c.id = r.chat_id
    WHERE r.id = ${reportId}::uuid`);
  return rows[0] ? toReport(rows[0]) : null;
}

export async function lockReport(tx: Tx, reportId: string): Promise<{ status: string } | null> {
  const { rows } = await tx.execute<{ status: string }>(sql`
    SELECT status FROM public.chat_reports WHERE id = ${reportId}::uuid FOR UPDATE`);
  return rows[0] ?? null;
}

export async function closeReport(
  tx: Tx,
  reportId: string,
  by: string,
  outcome: ChatReportOutcome,
  note: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.chat_reports
    SET status = 'closed', outcome = ${outcome}, outcome_note = ${note},
      closed_by_person_id = ${by}, closed_at = now()
    WHERE id = ${reportId}::uuid`);
}

type ReadSql = {
  id: string;
  report_id: string;
  requested_by_person_id: string;
  confirmed_by_person_id: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  created_at: string;
};

const toRead = (r: ReadSql): ReadRow => ({
  id: r.id,
  reportId: r.report_id,
  requestedByPersonId: r.requested_by_person_id,
  confirmedByPersonId: r.confirmed_by_person_id,
  confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
  expiresAt: r.expires_at ? new Date(r.expires_at) : null,
  createdAt: new Date(r.created_at),
});

export async function reads(tx: Tx, reportId: string): Promise<ReadRow[]> {
  const { rows } = await tx.execute<ReadSql>(sql`
    SELECT id, report_id, requested_by_person_id, confirmed_by_person_id,
      confirmed_at::text, expires_at::text, created_at::text
    FROM public.chat_report_reads WHERE report_id = ${reportId}::uuid ORDER BY id`);
  return rows.map(toRead);
}

export async function insertRead(
  tx: Tx,
  clubId: string,
  reportId: string,
  by: string,
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.chat_report_reads (club_id, report_id, requested_by_person_id)
    VALUES (${clubId}, ${reportId}, ${by}) RETURNING id`);
  return rows[0]!.id;
}

/** Confirms an open request (never by the one who asked); false when it was not open. */
export async function confirmRead(
  tx: Tx,
  readId: string,
  reportId: string,
  by: string,
  readHours: number,
  requestHours: number,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.chat_report_reads
    SET confirmed_by_person_id = ${by}, confirmed_at = now(),
      expires_at = now() + make_interval(hours => ${readHours})
    WHERE id = ${readId}::uuid AND report_id = ${reportId}::uuid
      AND confirmed_at IS NULL AND requested_by_person_id <> ${by}::uuid
      AND created_at > now() - make_interval(hours => ${requestHours})
    RETURNING id`);
  return rows.length > 0;
}

/** Whether the person may read the report's chat now (a confirmed read they are part of). */
export async function mayRead(tx: Tx, reportId: string, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.chat_report_reads
      WHERE report_id = ${reportId}::uuid AND expires_at > now()
        AND (requested_by_person_id = ${personId}::uuid OR confirmed_by_person_id = ${personId}::uuid)
    ) AS ok`);
  return rows[0]?.ok ?? false;
}

// --- Mutes ----------------------------------------------------------------------

/** The person's mute in the club, if any (chat_mutes_person_idx). */
export async function activeMute(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<{ id: string; until: Date } | null> {
  const { rows } = await tx.execute<{ id: string; until: string }>(sql`
    SELECT id, until::text FROM public.chat_mutes
    WHERE person_id = ${personId}::uuid AND club_id = ${clubId}::uuid
      AND lifted_at IS NULL AND until > now()
    ORDER BY until DESC LIMIT 1`);
  return rows[0] ? { id: rows[0].id, until: new Date(rows[0].until) } : null;
}

export async function insertMute(
  tx: Tx,
  input: { clubId: string; personId: string; by: string; reportId: string | null; hours: number },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.chat_mutes (club_id, person_id, muted_by_person_id, report_id, until)
    VALUES (${input.clubId}, ${input.personId}, ${input.by}, ${input.reportId},
      now() + make_interval(hours => ${input.hours}))
    RETURNING id`);
  return rows[0]!.id;
}

export async function liftMute(tx: Tx, muteId: string, by: string): Promise<string | null> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    UPDATE public.chat_mutes SET lifted_at = now(), lifted_by_person_id = ${by}
    WHERE id = ${muteId}::uuid AND lifted_at IS NULL RETURNING person_id`);
  return rows[0]?.person_id ?? null;
}

/** The club's mutes in force (chat_mutes_club_idx). */
export async function activeMutes(tx: Tx, clubId: string): Promise<MuteRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    muted_by_person_id: string;
    report_id: string | null;
    until: string;
  }>(sql`
    SELECT id, person_id, muted_by_person_id, report_id, until::text FROM public.chat_mutes
    WHERE club_id = ${clubId}::uuid AND lifted_at IS NULL AND until > now()
    ORDER BY until LIMIT 200`);
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    mutedByPersonId: r.muted_by_person_id,
    reportId: r.report_id,
    until: new Date(r.until),
  }));
}

/** Whether the person has been in one of the club's chats (who may be muted). */
export async function inClubChats(tx: Tx, clubId: string, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.chat_members
      WHERE person_id = ${personId}::uuid AND club_id = ${clubId}::uuid
    ) AS ok`);
  return rows[0]?.ok ?? false;
}
