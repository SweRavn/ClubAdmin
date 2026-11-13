// SPDX-License-Identifier: AGPL-3.0-only
// The outbox handler of notifications (P1.7, ADR 0039): turns domain events
// into notices for the people concerned and their guardians. Debounced
// kinds (changes of an activity or series, a late "not coming") are
// enqueued as `notifications:fanout` jobs with a job key, so a burst of
// changes gives one notice that reads the state when it runs.
//
// The account-bound emails of P1.1–P1.6 (decisions on requests, managers,
// exports, imports, family, offered places) moved here: their recipients
// come from the original email code (mail.ts, captured instead of sent),
// they get an inbox entry and push, and their email is rendered by that
// code when the delivery is sent, unchanged. Emails to an address without
// an account (invitations) stay in mail.ts.

import { type OutboxEvent, type OutboxHandler, sql, type Tx } from "@clubadmin/db";
import { catalogues, localeOf } from "@clubadmin/i18n";
import {
  DOMAIN_EVENTS,
  type DomainEventType,
  NOTICE_HORIZON_DAYS,
  NOTICE_LEAD_HOURS,
  type NotificationType,
} from "@clubadmin/shared";

import { clubHolders } from "../holders.ts";
import { mailHandler, type MailHandlerOptions, memoryMailProvider } from "../mail.ts";
import { type Channels, createNotices, debounce, type Notice } from "./fanout.ts";
import {
  activityFacts,
  activityParams,
  eventAudience,
  eventFacts,
  eventParams,
  participants,
  registrants,
  RIGHTS,
  useClub,
  withGuardians,
} from "./recipients.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const ACTIVITY_DEBOUNCE_MS = 10 * MINUTE_MS;
export const LATE_DECLINE_DEBOUNCE_MS = 5 * MINUTE_MS;

/** Events whose (account-bound) email moved into notifications. */
export const MOVED_EVENTS = [
  "join_request.decided",
  "club_creation_request.decided",
  "club.manager.changed",
  "members.exported",
  "members.import.finished",
  "guardianship.invitation.accepted",
  "guardianship.ward.own_login_age",
  "guardianship.ward.adult",
  "guardianship.adult.ended",
  "event.offer.made",
] as const satisfies readonly DomainEventType[];
type MovedEvent = (typeof MOVED_EVENTS)[number];

export interface NotificationsOptions {
  channels: Channels;
  /** The email code of the moved events (webUrl, invitation key); needed with or without SMTP. */
  mail: Omit<MailHandlerOptions, "provider">;
  now?: () => Date;
}

/** For one notice: who gets the original email, the original event kept to render it again. */
export interface MovedOrigin {
  type: MovedEvent;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Runs the original email code of a moved event without sending: the
 * messages it would send, by recipient person. Used to find the recipients
 * (fan-out) and to render a recipient's email (delivery).
 */
export async function movedEmails(
  tx: Tx,
  options: Omit<MailHandlerOptions, "provider">,
  origin: MovedOrigin,
): Promise<Map<string, { to: string; subject: string; text: string; messageId: string }>> {
  const capture = memoryMailProvider();
  await mailHandler({ ...options, provider: capture }).handle(
    { id: origin.idempotencyKey, clubId: null, ...origin } as unknown as OutboxEvent,
    tx,
  );
  return new Map(capture.sent.map((m) => [m.messageId.slice(m.messageId.lastIndexOf(".") + 1), m]));
}

/** The person's time zone for dates in notices (the account's, else Stockholm). */
async function accountTimeZone(tx: Tx, personId: string): Promise<string> {
  const { rows } = await tx.execute<{ time_zone: string | null }>(
    sql`SELECT time_zone FROM public.accounts WHERE person_id = ${personId}`,
  );
  return rows[0]?.time_zone ?? "Europe/Stockholm";
}

/** The club's administrators and the chair (P1.15 A3), distinct. */
export async function administratorsAndChair(tx: Tx, clubId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    ${clubHolders(clubId, "club.roles.manage")}
    UNION
    ${clubHolders(clubId, "club.managers.claim")}`);
  return rows.map((r) => r.person_id);
}

async function suspensionFacts(
  tx: Tx,
  suspensionId: string,
): Promise<{
  target: string;
  requestedBy: string;
  confirmedBy: string | null;
  reason: string;
} | null> {
  const { rows } = await tx.execute<{
    target_person_id: string;
    requested_by_person_id: string;
    confirmed_by_person_id: string | null;
    reason: string;
  }>(sql`
    SELECT target_person_id, requested_by_person_id, confirmed_by_person_id, reason
    FROM public.administrator_suspensions WHERE id = ${suspensionId}`);
  const row = rows[0];
  return row
    ? {
        target: row.target_person_id,
        requestedBy: row.requested_by_person_id,
        confirmedBy: row.confirmed_by_person_id,
        reason: row.reason,
      }
    : null;
}

async function graceOf(tx: Tx, clubId: string): Promise<Date | null> {
  const { rows } = await tx.execute<{ grace_until: string | null }>(sql`
    SELECT administrators_grace_until AS grace_until FROM public.clubs WHERE id = ${clubId}`);
  return rows[0]?.grace_until ? new Date(rows[0].grace_until) : null;
}

/** The waiting-list events that become notices (P1.10a, P1.10b). */
const WAITLIST_EVENTS = [
  "waitlist.entry.created",
  "waitlist.offer.sent",
  "waitlist.offer.expired",
  "waitlist.admitted",
  "waitlist.entry.closed",
] as const;

export function notificationsHandler(options: NotificationsOptions): OutboxHandler {
  const now = () => options.now?.() ?? new Date();
  const notify = (tx: Tx, notices: Notice[]) =>
    createNotices(tx, notices, { channels: options.channels, now: now() });

  return {
    name: "notifications",
    types: [
      "activity.changed",
      "activity_series.changed",
      "activity.invitees.changed",
      "activity.response.changed",
      "event.changed",
      "event.registration.changed",
      "account.email.changed",
      "membership.left",
      "assignment.ended",
      // Club-defined roles (P1.15 A2).
      "roles.manager_split",
      "role.updated",
      "role.self_assigned",
      "role.unassigned",
      // At least two administrators (P1.15 A3).
      "administrator.suspension.requested",
      "administrator.suspended",
      "administrator.suspension.closed",
      "administrator.added",
      "club.administrators.grace_started",
      // Child safety in chat (P2.1 part B).
      "chat.report.created",
      "chat.report.read_requested",
      "chat.message.moderated",
      "chat.member.muted",
      "chat.message.created",
      ...WAITLIST_EVENTS,
      "club.privacy_policy.published",
      "privacy.export.ready",
      "privacy.erasure.scheduled",
      "privacy.erasure.blocked",
      "calendar.feed.revoked",
      "person.protection.changed",
      // Billing (P1.13; published only with billing on).
      "billing.invoice.issued",
      "billing.invoice.overdue",
      "billing.subscription.changed",
      "billing.card.failed",
      ...MOVED_EVENTS,
    ],
    async handle(event, tx) {
      const at = now();
      switch (event.type) {
        case "activity.changed": {
          const { clubId, activityId, change } = DOMAIN_EVENTS["activity.changed"].parse(
            event.payload,
          );
          if (change === "updated") {
            await debounce(
              tx,
              `notify:activity:${activityId}`,
              { kind: "activity", clubId, activityId },
              ACTIVITY_DEBOUNCE_MS,
              at,
            );
            return;
          }
          if (change === "deleted") return;
          const a = await activityFacts(tx, clubId, activityId);
          if (!a || a.startsAt.getTime() <= at.getTime()) return;
          const withinHorizon = a.startsAt.getTime() <= at.getTime() + NOTICE_HORIZON_DAYS * DAY_MS;
          let type: NotificationType;
          if (change === "created") {
            // Sessions of a series are announced with the series, not one by one.
            if (a.seriesId || a.status !== "scheduled") return;
            if (!withinHorizon && a.responseMode !== "requested") return;
            type = "activity.added";
          } else {
            if (!withinHorizon) return;
            type = change === "cancelled" ? "activity.cancelled" : "activity.restored";
          }
          const people = await withGuardians(tx, await participants(tx, a.id), RIGHTS.schedule);
          await notify(
            tx,
            [...people].map(([recipient, about]) => ({
              recipientPersonId: recipient,
              clubId,
              type,
              subjectType: "activity",
              subjectId: a.id,
              about,
              params: activityParams(a),
              dedupeKey: `activity:${a.id}:${change}:${a.sequence}`,
              dueAt: a.respondBy && change === "created" ? a.respondBy : a.startsAt,
            })),
          );
          return;
        }
        case "activity_series.changed": {
          const { clubId, seriesId, change } = DOMAIN_EVENTS["activity_series.changed"].parse(
            event.payload,
          );
          // New series: their groups see them in the calendar; changes are news.
          if (change === "created") return;
          await debounce(
            tx,
            `notify:series:${seriesId}`,
            { kind: "series", clubId, seriesId },
            ACTIVITY_DEBOUNCE_MS,
            at,
          );
          return;
        }
        case "activity.invitees.changed": {
          const { clubId, activityId, added, removed } = DOMAIN_EVENTS[
            "activity.invitees.changed"
          ].parse(event.payload);
          const a = await activityFacts(tx, clubId, activityId);
          if (!a || a.status !== "scheduled" || a.startsAt.getTime() <= at.getTime()) return;
          // At once, however far ahead (decision 7): people answer early.
          const notices: Notice[] = [];
          for (const [change, ids] of [
            ["added", added],
            ["removed", removed],
          ] as const) {
            const people = await withGuardians(tx, ids, RIGHTS.schedule);
            for (const [recipient, about] of people) {
              notices.push({
                recipientPersonId: recipient,
                clubId,
                type: change === "added" ? "callup.added" : "callup.removed",
                subjectType: "activity",
                subjectId: a.id,
                about,
                params: activityParams(a),
                dedupeKey: `callup:${a.id}:${change}:${event.idempotencyKey}`,
                dueAt: a.respondBy ?? a.startsAt,
              });
            }
          }
          await notify(tx, notices);
          return;
        }
        case "activity.response.changed": {
          const { clubId, activityId, personId, change } = DOMAIN_EVENTS[
            "activity.response.changed"
          ].parse(event.payload);
          if (change !== "set") return;
          const a = await activityFacts(tx, clubId, activityId);
          if (!a || a.status !== "scheduled" || a.startsAt.getTime() <= at.getTime()) return;
          const late =
            (a.respondBy !== null && a.respondBy.getTime() < at.getTime()) ||
            a.startsAt.getTime() - at.getTime() <= NOTICE_LEAD_HOURS * HOUR_MS;
          if (!late) return;
          // The job reads the answer when it runs: changed back within 5 minutes, nothing.
          await debounce(
            tx,
            `notify:late:${activityId}:${personId}`,
            { kind: "late", clubId, activityId, personId },
            LATE_DECLINE_DEBOUNCE_MS,
            at,
          );
          return;
        }
        case "event.changed": {
          const { clubId, eventId, change } = DOMAIN_EVENTS["event.changed"].parse(event.payload);
          if (change !== "published" && change !== "cancelled") return;
          const e = await eventFacts(tx, clubId, eventId);
          if (!e || e.startsAt.getTime() <= at.getTime()) return;
          const people =
            change === "published" ? await eventAudience(tx, e) : await registrants(tx, e.id);
          const recipients = await withGuardians(tx, people, RIGHTS.events);
          await notify(
            tx,
            [...recipients].map(([recipient, about]) => ({
              recipientPersonId: recipient,
              clubId,
              type: change === "published" ? "event.published" : "event.cancelled",
              subjectType: "event",
              subjectId: e.id,
              about,
              params: eventParams(e),
              dedupeKey: `event:${e.id}:${change}`,
              dueAt: change === "published" ? e.closesAt : e.startsAt,
            })),
          );
          return;
        }
        case "event.registration.changed": {
          const { clubId, eventId, registrationId, personId } = DOMAIN_EVENTS[
            "event.registration.changed"
          ].parse(event.payload);
          const e = await eventFacts(tx, clubId, eventId);
          if (!e) return;
          const { rows } = await tx.execute<{
            status: string;
            registered_by_person_id: string;
            fresh: boolean;
            decided: boolean;
          }>(sql`
            SELECT status, registered_by_person_id, decided_by_person_id IS NOT NULL AS decided,
              updated_at - created_at < interval '1 minute' AS fresh
            FROM public.event_registrations WHERE id = ${registrationId}`);
          const reg = rows[0];
          if (!reg) return;
          // A new sign-up tells the other guardians (not the one who signed up);
          // places given from the queue come as offers (event.offer.made).
          const type: NotificationType | null =
            reg.status === "removed" && reg.decided
              ? "event.registration.removed"
              : reg.fresh && reg.status === "confirmed"
                ? "event.registration.confirmed"
                : reg.fresh && reg.status === "waitlisted"
                  ? "event.registration.waitlisted"
                  : null;
          if (!type) return;
          const recipients = await withGuardians(tx, [personId], RIGHTS.events);
          if (type !== "event.registration.removed") recipients.delete(reg.registered_by_person_id);
          await notify(
            tx,
            [...recipients].map(([recipient, about]) => ({
              recipientPersonId: recipient,
              clubId,
              type,
              subjectType: "event",
              subjectId: e.id,
              about,
              params: eventParams(e),
              dedupeKey: `event:${e.id}:registration:${registrationId}:${reg.status}:${event.idempotencyKey}`,
              dueAt: e.startsAt,
            })),
          );
          return;
        }
        case "account.email.changed": {
          const { accountId, personId } = DOMAIN_EVENTS["account.email.changed"].parse(
            event.payload,
          );
          // The old address is read from the account's history when the email is sent.
          await notify(tx, [
            {
              recipientPersonId: personId,
              clubId: null,
              type: "account.email.changed",
              subjectType: "account",
              subjectId: accountId,
              about: [],
              params: {},
              dedupeKey: `account:${event.idempotencyKey}`,
            },
          ]);
          return;
        }
        // Privacy (P1.8a): a member left; someone stepped down; a new policy.
        case "membership.left": {
          const { clubId, personId } = DOMAIN_EVENTS["membership.left"].parse(event.payload);
          await useClub(tx, clubId);
          // Those who manage memberships (registrars) and administer the club
          // (club managers, P1.15 A2).
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT DISTINCT h.person_id FROM (
              ${clubHolders(clubId, "club.members.manage")}
              UNION ${clubHolders(clubId, "club.roles.manage")}) h
            WHERE h.person_id <> ${personId}`);
          await notify(
            tx,
            rows.map((r) => ({
              recipientPersonId: r.person_id,
              clubId,
              type: "membership.left" as const,
              subjectType: "club_membership",
              subjectId: null,
              about: [personId],
              params: {},
              dedupeKey: `membership.left:${event.idempotencyKey}`,
            })),
          );
          return;
        }
        // Club-defined roles (P1.15 A2): never naming a person in the texts.
        case "roles.manager_split": {
          const { clubId } = DOMAIN_EVENTS["roles.manager_split"].parse(event.payload);
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{ person_id: string }>(
            sql`${clubHolders(clubId, "club.roles.manage")}`,
          );
          // eslint-disable-next-line clubadmin/no-role-names -- names the template role that took the work (a label)
          const registrar = await roleNameOfKey(tx, clubId, "registrar");
          await notify(
            tx,
            rows.map((r) => ({
              recipientPersonId: r.person_id,
              clubId,
              type: "roles.manager_split" as const,
              subjectType: "club_roles",
              subjectId: clubId,
              about: [],
              params: { role: registrar },
              dedupeKey: `roles.manager_split:${clubId}`,
            })),
          );
          return;
        }
        case "role.updated": {
          const { clubId, roleId, removed } = DOMAIN_EVENTS["role.updated"].parse(event.payload);
          if (removed.length === 0) return;
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role_id = ${roleId} AND valid_to IS NULL
            UNION
            SELECT person_id FROM public.group_memberships
            WHERE club_id = ${clubId} AND role_id = ${roleId} AND valid_to IS NULL`);
          const role = await roleName(tx, clubId, roleId);
          await notify(
            tx,
            rows.map((r) => ({
              recipientPersonId: r.person_id,
              clubId,
              type: "role.permissions.removed" as const,
              subjectType: "my_roles",
              subjectId: roleId,
              about: [],
              params: { role, count: removed.length },
              dedupeKey: `role.permissions.removed:${event.idempotencyKey}`,
            })),
          );
          return;
        }
        case "role.self_assigned": {
          const { clubId, personId, roleId } = DOMAIN_EVENTS["role.self_assigned"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          // The other administrators and the chair (decision 3).
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            ${clubHolders(clubId, "club.roles.manage")}
            UNION
            ${clubHolders(clubId, "club.managers.claim")}`);
          const role = await roleName(tx, clubId, roleId);
          await notify(
            tx,
            rows
              .filter((r) => r.person_id !== personId)
              .map((r) => ({
                recipientPersonId: r.person_id,
                clubId,
                type: "role.self_assigned" as const,
                subjectType: "club_roles",
                subjectId: clubId,
                about: [personId],
                params: { role },
                dedupeKey: `role.self_assigned:${event.idempotencyKey}`,
              })),
          );
          return;
        }
        case "administrator.suspension.requested":
        case "administrator.suspended": {
          const type = event.type;
          const { clubId, suspensionId } = DOMAIN_EVENTS[type].parse(event.payload);
          await useClub(tx, clubId);
          const suspension = await suspensionFacts(tx, suspensionId);
          if (!suspension) return;
          // The target (told at once, so that a mistaken or malicious request
          // is visible), every administrator and the chair; not the one who acted.
          const actor =
            type === "administrator.suspended" ? suspension.confirmedBy : suspension.requestedBy;
          const recipients = new Set([
            suspension.target,
            ...(await administratorsAndChair(tx, clubId)),
          ]);
          if (actor) recipients.delete(actor);
          await notify(
            tx,
            [...recipients].map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type,
              subjectType: "club_administrators",
              subjectId: clubId,
              about: recipient === suspension.target ? [] : [suspension.target],
              params: { reason: suspension.reason, self: recipient === suspension.target },
              dedupeKey: `${type}:${suspensionId}`,
            })),
          );
          return;
        }
        // Child safety in chat (P2.1 part B): the safeguarding officers get a
        // report at once and a request to read (another officer must
        // confirm); never who reported or what was written.
        case "chat.report.created":
        case "chat.report.read_requested": {
          const type = event.type;
          const payload =
            type === "chat.report.read_requested"
              ? DOMAIN_EVENTS[type].parse(event.payload)
              : { ...DOMAIN_EVENTS[type].parse(event.payload), readId: null };
          await useClub(tx, payload.clubId);
          const { rows } = await tx.execute<{
            reason: string;
            has_children: boolean;
            requested_by: string | null;
          }>(sql`
            SELECT r.reason, c.has_children,
              (SELECT x.requested_by_person_id FROM public.chat_report_reads x
               WHERE x.id = ${payload.readId}::uuid) AS requested_by
            FROM public.chat_reports r JOIN public.chats c ON c.id = r.chat_id
            WHERE r.id = ${payload.reportId}::uuid`);
          const report = rows[0];
          if (!report) return;
          const officers = await tx.execute<{ person_id: string }>(
            clubHolders(payload.clubId, "club.safeguarding.handle"),
          );
          await notify(
            tx,
            officers.rows
              .map((r) => r.person_id)
              .filter((id) => id !== report.requested_by)
              .map((recipient) => ({
                recipientPersonId: recipient,
                clubId: payload.clubId,
                type: type === "chat.report.created" ? "chat.report.received" : type,
                subjectType: "chat_report",
                subjectId: payload.reportId,
                about: [],
                params: { reportReason: report.reason, children: report.has_children },
                dedupeKey: `${type}:${payload.readId ?? payload.reportId}`,
              })),
          );
          return;
        }
        // A new message (P2.1 part C): the chat's active members other than the
        // sender, per their push setting ("mentions": replies to their own
        // messages until mentions exist). One notice per chat until the member
        // reads further (the dedupe key holds their read pointer). Never the
        // text or the sender's name, in every chat (ADR 0047 rule 13).
        case "chat.message.created": {
          const { clubId, chatId, messageId } = DOMAIN_EVENTS["chat.message.created"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{
            person_id: string;
            last_read: string | null;
            name: string | null;
            kind: string;
            has_children: boolean;
          }>(sql`
            WITH msg AS (
              SELECT m.sender_person_id,
                (SELECT r.sender_person_id FROM public.chat_messages r
                 WHERE r.id = m.reply_to_message_id) AS replied_to
              FROM public.chat_messages m WHERE m.id = ${messageId}::uuid)
            SELECT cm.person_id, cm.last_read_message_id AS last_read, c.name, c.kind, c.has_children
            FROM public.chat_members cm
            JOIN public.chats c ON c.id = cm.chat_id
            CROSS JOIN msg
            WHERE cm.chat_id = ${chatId}::uuid AND cm.status = 'active'
              AND cm.person_id IS DISTINCT FROM msg.sender_person_id
              AND (cm.push = 'all' OR (cm.push = 'mentions' AND cm.person_id = msg.replied_to))
              AND (cm.last_read_message_id IS NULL OR cm.last_read_message_id < ${messageId}::uuid)`);
          await notify(
            tx,
            rows.map((r) => ({
              recipientPersonId: r.person_id,
              clubId,
              type: "chat.message" as const,
              subjectType: "chat",
              subjectId: chatId,
              about: [],
              params: {
                chatName: r.kind === "direct" ? null : r.name,
                direct: r.kind === "direct",
                children: r.has_children,
              },
              dedupeKey: `chat.message:${chatId}:${r.last_read ?? "none"}`,
            })),
          );
          return;
        }
        // The sender of a hidden message and a muted member are told (ADR 0047 rule 11).
        case "chat.message.moderated": {
          const { clubId, chatId, messageId, personId } = DOMAIN_EVENTS[
            "chat.message.moderated"
          ].parse(event.payload);
          await useClub(tx, clubId);
          await notify(tx, [
            {
              recipientPersonId: personId,
              clubId,
              type: "chat.message.moderated",
              subjectType: "chat",
              subjectId: chatId,
              about: [],
              params: {},
              dedupeKey: `chat.message.moderated:${messageId}`,
            },
          ]);
          return;
        }
        case "chat.member.muted": {
          const { clubId, muteId, personId } = DOMAIN_EVENTS["chat.member.muted"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{ until: string }>(sql`
            SELECT until::text FROM public.chat_mutes WHERE id = ${muteId}::uuid`);
          if (!rows[0]) return;
          await notify(tx, [
            {
              recipientPersonId: personId,
              clubId,
              type: "chat.member.muted",
              subjectType: "chat_mute",
              subjectId: muteId,
              about: [],
              params: { until: new Date(rows[0].until).toISOString() },
              dedupeKey: `chat.member.muted:${muteId}`,
            },
          ]);
          return;
        }
        case "administrator.suspension.closed": {
          const { clubId, suspensionId, status } = DOMAIN_EVENTS[
            "administrator.suspension.closed"
          ].parse(event.payload);
          await useClub(tx, clubId);
          const suspension = await suspensionFacts(tx, suspensionId);
          if (!suspension) return;
          await notify(
            tx,
            [suspension.target, suspension.requestedBy].map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type: "administrator.suspension.closed" as const,
              subjectType: "club_administrators",
              subjectId: clubId,
              about: recipient === suspension.target ? [] : [suspension.target],
              params: { status, self: recipient === suspension.target },
              dedupeKey: `administrator.suspension.closed:${suspensionId}`,
            })),
          );
          return;
        }
        case "administrator.added": {
          const { clubId, personId } = DOMAIN_EVENTS["administrator.added"].parse(event.payload);
          await useClub(tx, clubId);
          const recipients = (await administratorsAndChair(tx, clubId)).filter(
            (r) => r !== personId,
          );
          await notify(
            tx,
            recipients.map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type: "administrator.added" as const,
              subjectType: "club_administrators",
              subjectId: clubId,
              about: [personId],
              params: {},
              dedupeKey: `administrator.added:${event.idempotencyKey}`,
            })),
          );
          return;
        }
        case "club.administrators.grace_started": {
          const { clubId } = DOMAIN_EVENTS["club.administrators.grace_started"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          const graceUntil = await graceOf(tx, clubId);
          if (!graceUntil) return;
          await notify(
            tx,
            (await administratorsAndChair(tx, clubId)).map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type: "club.administrators.grace_started" as const,
              subjectType: "club_administrators",
              subjectId: clubId,
              about: [],
              params: { graceUntil: graceUntil.toISOString() },
              dedupeKey: `club.administrators.grace_started:${clubId}`,
            })),
          );
          return;
        }
        case "role.unassigned": {
          const { clubId, personId, roleId } = DOMAIN_EVENTS["role.unassigned"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          await notify(tx, [
            {
              recipientPersonId: personId,
              clubId,
              type: "role.unassigned" as const,
              subjectType: "my_roles",
              subjectId: roleId,
              about: [],
              params: { role: await roleName(tx, clubId, roleId) },
              dedupeKey: `role.unassigned:${event.idempotencyKey}`,
            },
          ]);
          return;
        }
        case "assignment.ended": {
          const { clubId, personId, kind, groupId } = DOMAIN_EVENTS["assignment.ended"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            ${clubHolders(clubId, "club.roles.manage")}
            UNION
            SELECT person_id FROM public.group_owners
            WHERE club_id = ${clubId} AND group_id = ${groupId ?? null}::uuid AND valid_to IS NULL`);
          await notify(
            tx,
            rows
              .filter((r) => r.person_id !== personId)
              .map((r) => ({
                recipientPersonId: r.person_id,
                clubId,
                type: "assignment.ended" as const,
                subjectType: "club",
                subjectId: clubId,
                about: [personId],
                params: { kind },
                dedupeKey: `assignment.ended:${event.idempotencyKey}`,
              })),
          );
          return;
        }
        // Waiting lists (P1.10a, P1.10b; ADR 0043): the applicant (if they
        // have a login) and whoever applied for them are told; an offer also
        // reaches the applicant's full guardians. The group's name, the
        // reason code and the deadline only: never a note.
        case "waitlist.entry.created":
        case "waitlist.offer.sent":
        case "waitlist.offer.expired":
        case "waitlist.admitted":
        case "waitlist.entry.closed": {
          const type = event.type;
          const { clubId, entryId } = DOMAIN_EVENTS[type].parse(event.payload);
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{
            person_id: string;
            requested_by_person_id: string;
            closed_reason: string | null;
            offer_expires_at: Date | null;
            group_id: string;
            group_name: string;
            time_zone: string;
          }>(sql`
            SELECT w.person_id, w.requested_by_person_id, w.closed_reason, w.offer_expires_at,
              w.group_id, g.name AS group_name, c.time_zone
            FROM public.group_waitlist_entries w
            JOIN public.groups g ON g.id = w.group_id
            JOIN public.clubs c ON c.id = w.club_id
            WHERE w.id = ${entryId}`);
          const entry = rows[0];
          if (!entry) return;
          const recipients = new Set([entry.person_id, entry.requested_by_person_id]);
          if (type === "waitlist.offer.sent") {
            const family = await withGuardians(tx, [entry.person_id], ["act_on_behalf"]);
            for (const id of family.keys()) recipients.add(id);
          }
          await notify(
            tx,
            [...recipients].map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type,
              subjectType: "group_waitlist_entry",
              subjectId: entryId,
              about: [entry.person_id],
              params: {
                group: entry.group_name,
                ...(type === "waitlist.entry.closed"
                  ? { closedReason: entry.closed_reason ?? "removed_by_owner" }
                  : {}),
                ...(type === "waitlist.offer.sent" && entry.offer_expires_at
                  ? { deadline: entry.offer_expires_at, timeZone: entry.time_zone }
                  : {}),
              },
              dedupeKey: `${type}:${entryId}`,
            })),
          );
          // P1.14: those who may admit learn of a new application: the
          // owners of the group or its ancestors, else the club managers.
          if (type === "waitlist.entry.created") {
            const admitters = (await waitlistAdmitters(tx, clubId, entryId)).filter(
              (id) => id !== entry.requested_by_person_id && id !== entry.person_id,
            );
            await notify(
              tx,
              admitters.map((recipient) => ({
                recipientPersonId: recipient,
                clubId,
                type: "waitlist.entry.received" as const,
                subjectType: "group_waitlist",
                subjectId: entry.group_id,
                about: [entry.person_id],
                params: { group: entry.group_name },
                dedupeKey: `waitlist.entry.received:${entryId}`,
              })),
            );
          }
          return;
        }
        case "club.privacy_policy.published": {
          const { clubId, policyId } = DOMAIN_EVENTS["club.privacy_policy.published"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          // Members and the full guardians of members (one statement each).
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT m.person_id FROM public.club_memberships m
            WHERE m.club_id = ${clubId} AND m.valid_to IS NULL AND m.status IN ('active', 'paused')`);
          const recipients = await withGuardians(
            tx,
            rows.map((r) => r.person_id),
            ["act_on_behalf"],
          );
          await notify(
            tx,
            [...recipients.keys()].map((recipient) => ({
              recipientPersonId: recipient,
              clubId,
              type: "club.privacy_policy.updated" as const,
              subjectType: "club_privacy_policy",
              subjectId: policyId,
              about: [],
              params: {},
              dedupeKey: `club.privacy_policy:${policyId}`,
            })),
          );
          return;
        }
        // Privacy (P1.8b): a data file is ready; an erasure was scheduled or stopped.
        case "privacy.export.ready": {
          const { exportId, requestedByPersonId } = DOMAIN_EVENTS["privacy.export.ready"].parse(
            event.payload,
          );
          await notify(tx, [
            {
              recipientPersonId: requestedByPersonId,
              clubId: null,
              type: "privacy.export.ready",
              subjectType: "data_export",
              subjectId: exportId,
              about: [],
              params: {},
              dedupeKey: `privacy.export.ready:${exportId}`,
            },
          ]);
          return;
        }
        // Protected identity (P1.12): every club manager of the affected clubs
        // (the club; for the global flag every club where the person or a ward
        // of theirs is a member), never naming the person; when a guardian
        // turns a child's flag off, the other full guardians too.
        case "person.protection.changed": {
          const payload = DOMAIN_EVENTS["person.protection.changed"].parse(event.payload);
          if (payload.enabled === undefined) return;
          const by = payload.byPersonId ?? null;
          let clubIds: string[];
          if (payload.clubId) {
            clubIds = [payload.clubId];
          } else {
            const { rows } = await tx.execute<{ id: string }>(
              sql`SELECT privacy.person_club_ids(${payload.personId}) AS id`,
            );
            clubIds = rows.map((r) => r.id);
          }
          const notices: Notice[] = [];
          for (const clubId of clubIds) {
            await useClub(tx, clubId);
            const { rows } = await tx.execute<{ person_id: string }>(sql`
              SELECT DISTINCT h.person_id FROM (${clubHolders(clubId, "person.protection.set")}) h
              WHERE h.person_id <> ${payload.personId}
                AND h.person_id IS DISTINCT FROM ${by}::uuid`);
            for (const r of rows) {
              notices.push({
                recipientPersonId: r.person_id,
                clubId,
                type: "member.protection.changed",
                subjectType: "club_protected",
                subjectId: null,
                about: [],
                params: { change: payload.enabled ? "on" : "off" },
                dedupeKey: `member.protection.changed:${event.idempotencyKey}:${clubId}`,
              });
            }
          }
          await tx.execute(sql`SELECT set_config('app.club_id', '', true)`);
          if (!payload.enabled && !payload.clubId && by && by !== payload.personId) {
            const { rows } = await tx.execute<{ guardian_person_id: string }>(sql`
              SELECT guardian_person_id FROM public.guardianships
              WHERE ward_person_id = ${payload.personId} AND guardian_person_id <> ${by}
                AND kind IN ('parent', 'legal_guardian') AND status = 'active'
                AND valid_to IS NULL`);
            for (const g of rows) {
              notices.push({
                recipientPersonId: g.guardian_person_id,
                clubId: null,
                type: "family.protection.removed",
                subjectType: "guardianship",
                subjectId: null,
                about: [],
                params: {},
                dedupeKey: `family.protection.removed:${event.idempotencyKey}`,
              });
            }
          }
          await notify(tx, notices);
          return;
        }
        // Calendar subscriptions (P1.11): the owner is told when the system
        // revoked a feed (unused for a year, access lost); not when they
        // removed or replaced it themselves.
        // Billing (P1.13, ADR 0045): club managers and treasurers (the trial's
        // end: club managers) get a catalogue notice with the invoice number,
        // amount and dates; the invoice itself goes to the invoice address.
        case "billing.invoice.issued":
        case "billing.invoice.overdue":
        case "billing.subscription.changed":
        case "billing.card.failed": {
          const notices = await billingNotices(tx, event);
          await notify(tx, notices);
          return;
        }
        case "calendar.feed.revoked": {
          const { feedId, personId } = DOMAIN_EVENTS["calendar.feed.revoked"].parse(event.payload);
          const { rows } = await tx.execute<{ revoked_reason: string | null }>(sql`
            SELECT revoked_reason FROM public.calendar_feeds WHERE id = ${feedId}`);
          const reason = rows[0]?.revoked_reason;
          if (reason !== "unused" && reason !== "access_lost") return;
          await notify(tx, [
            {
              recipientPersonId: personId,
              clubId: null,
              type: "calendar.feed.revoked",
              subjectType: "calendar_feed",
              subjectId: feedId,
              about: [],
              params: { feedReason: reason },
              dedupeKey: `calendar.feed.revoked:${feedId}`,
            },
          ]);
          return;
        }
        case "privacy.erasure.scheduled":
        case "privacy.erasure.blocked": {
          const { requestId } = DOMAIN_EVENTS[event.type].parse(event.payload);
          const { rows } = await tx.execute<{
            person_id: string;
            requested_by_person_id: string;
            kind: string;
            scheduled_for: Date;
          }>(sql`
            SELECT person_id, requested_by_person_id, kind, scheduled_for
            FROM public.erasure_requests WHERE id = ${requestId}`);
          const request = rows[0];
          if (!request) return;
          const scheduledFor = new Date(request.scheduled_for).toISOString();
          if (event.type === "privacy.erasure.blocked") {
            await notify(tx, [
              {
                recipientPersonId: request.requested_by_person_id,
                clubId: null,
                type: "account.deletion.blocked",
                subjectType: "erasure_request",
                subjectId: requestId,
                about: request.kind === "ward_erasure" ? [request.person_id] : [],
                params: {},
                dedupeKey: `account.deletion.blocked:${requestId}`,
              },
            ]);
            return;
          }
          if (request.kind === "account_deletion") {
            const timeZone = await accountTimeZone(tx, request.person_id);
            await notify(tx, [
              {
                recipientPersonId: request.person_id,
                clubId: null,
                type: "account.deletion.scheduled",
                subjectType: "erasure_request",
                subjectId: requestId,
                about: [],
                params: { scheduledFor, timeZone },
                dedupeKey: `account.deletion.scheduled:${requestId}`,
              },
            ]);
            return;
          }
          // A ward's erasure: every other full guardian is told and may cancel.
          const { rows: guardians } = await tx.execute<{ guardian_person_id: string }>(sql`
            SELECT guardian_person_id FROM public.guardianships
            WHERE ward_person_id = ${request.person_id}
              AND guardian_person_id <> ${request.requested_by_person_id}
              AND kind IN ('parent', 'legal_guardian') AND status = 'active'
              AND valid_to IS NULL`);
          const notices: Notice[] = [];
          for (const g of guardians) {
            notices.push({
              recipientPersonId: g.guardian_person_id,
              clubId: null,
              type: "person.erasure.scheduled",
              subjectType: "erasure_request",
              subjectId: requestId,
              about: [request.person_id],
              params: { scheduledFor, timeZone: await accountTimeZone(tx, g.guardian_person_id) },
              dedupeKey: `person.erasure.scheduled:${requestId}`,
            });
          }
          await notify(tx, notices);
          return;
        }
        default:
          if ((MOVED_EVENTS as readonly string[]).includes(event.type)) {
            await movedEvent(tx, event as OutboxEvent<MovedEvent>);
          }
      }
    },
  };

  async function movedEvent(tx: Tx, event: OutboxEvent<MovedEvent>): Promise<void> {
    const origin: MovedOrigin = {
      type: event.type,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    };
    const emails = await movedEmails(tx, options.mail, origin);
    if (emails.size === 0) return;
    const shape = await movedShape(tx, origin);
    if (!shape) return;
    await notify(
      tx,
      [...emails.keys()].map((recipient) => ({
        recipientPersonId: recipient,
        clubId: shape.clubId,
        type: shape.type,
        subjectType: shape.subjectType,
        subjectId: shape.subjectId,
        about: shape.about.filter((id) => id !== recipient),
        params: { ...shape.params, origin },
        dedupeKey: `${origin.type}:${event.idempotencyKey}`,
        dueAt: shape.dueAt ?? null,
      })),
    );
  }
}

interface MovedShape {
  type: NotificationType;
  clubId: string | null;
  subjectType: string;
  subjectId: string | null;
  about: string[];
  params: Record<string, unknown>;
  dueAt?: Date | null;
}

/** Type, subject and params (no names) of a moved event's notice. */
async function movedShape(tx: Tx, origin: MovedOrigin): Promise<MovedShape | null> {
  const p = origin.payload;
  const id = (key: string) => (typeof p[key] === "string" ? p[key] : null);
  switch (origin.type) {
    case "join_request.decided": {
      const clubId = id("clubId")!;
      await useClub(tx, clubId);
      const { rows } = await tx.execute<{ person_id: string; status: string }>(sql`
        SELECT person_id, status FROM public.join_requests WHERE id = ${id("joinRequestId")}`);
      return {
        type: "join_request.decided",
        clubId,
        subjectType: "club",
        subjectId: clubId,
        about: rows[0] ? [rows[0].person_id] : [],
        params: { status: rows[0]?.status ?? "" },
      };
    }
    case "club_creation_request.decided": {
      const { rows } = await tx.execute<{
        status: string;
        name: string;
        created_club_id: string | null;
      }>(sql`
        SELECT status, name, created_club_id FROM public.club_creation_requests WHERE id = ${id("requestId")}`);
      return {
        type: "club_creation.decided",
        clubId: null,
        subjectType: "club_creation_request",
        subjectId: id("requestId"),
        about: [],
        params: {
          status: rows[0]?.status ?? "",
          title: rows[0]?.name ?? "",
          createdClubId: rows[0]?.created_club_id ?? null,
        },
      };
    }
    case "club.manager.changed":
      return {
        type: "club.managers.changed",
        clubId: id("clubId"),
        subjectType: "club",
        subjectId: id("clubId"),
        about: id("personId") ? [id("personId")!] : [],
        params: { change: p.change ?? "" },
      };
    case "members.exported":
      return {
        type: "members.exported",
        clubId: id("clubId"),
        subjectType: "member_export",
        subjectId: id("exportId"),
        about: [],
        params: {},
      };
    case "members.import.finished": {
      const clubId = id("clubId")!;
      await useClub(tx, clubId);
      const { rows } = await tx.execute<{ status: string; counts: { imported?: number } }>(sql`
        SELECT status, counts FROM public.member_imports WHERE id = ${id("importId")}`);
      return {
        type: "members.import.finished",
        clubId,
        subjectType: "member_import",
        subjectId: id("importId"),
        about: [],
        params: {
          status: rows[0]?.status === "done" ? "done" : "failed",
          imported: rows[0]?.counts.imported ?? 0,
        },
      };
    }
    case "guardianship.invitation.accepted":
      return {
        type: "family.accepted",
        clubId: null,
        subjectType: "guardianship",
        subjectId: null,
        about: id("wardPersonId") ? [id("wardPersonId")!] : [],
        params: {},
      };
    case "guardianship.ward.own_login_age":
      return {
        type: "family.own_login_age",
        clubId: null,
        subjectType: "guardianship",
        subjectId: null,
        about: [id("wardPersonId")!],
        params: {},
      };
    case "guardianship.ward.adult":
      return {
        type: "family.adult",
        clubId: null,
        subjectType: "guardianship",
        subjectId: null,
        about: [id("wardPersonId")!],
        params: {},
      };
    case "guardianship.adult.ended":
      // No longer family: the notice does not name the young person.
      return {
        type: "family.adult_ended",
        clubId: null,
        subjectType: "guardianship",
        subjectId: null,
        about: [],
        params: {},
      };
    case "event.offer.made": {
      const clubId = id("clubId")!;
      const e = await eventFacts(tx, clubId, id("eventId")!);
      if (!e) return null;
      const { rows } = await tx.execute<{ offer_expires_at: string | null }>(sql`
        SELECT offer_expires_at FROM public.event_registrations WHERE id = ${id("registrationId")}`);
      const offered = p.kind === "offered";
      return {
        type: offered ? "event.offer.offered" : "event.offer.confirmed",
        clubId,
        subjectType: "event",
        subjectId: e.id,
        about: [id("personId")!],
        params: {
          ...eventParams(e),
          ...(offered && rows[0]?.offer_expires_at ? { deadline: rows[0].offer_expires_at } : {}),
        },
        dueAt: e.startsAt,
      };
    }
    default:
      return null;
  }
}

/**
 * Who gets billing notices: those who read the club's invoices (managers and
 * treasurers), or only those who choose the plan (managers).
 */
async function billingRecipients(tx: Tx, clubId: string, managersOnly: boolean): Promise<string[]> {
  const permission = managersOnly ? "billing.subscription.change" : "billing.invoices.read";
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT h.person_id FROM (${clubHolders(clubId, permission)}) h`);
  return rows.map((r) => r.person_id);
}

/** The notices of a billing event (none for changes nobody needs to hear about). */
async function billingNotices(tx: Tx, event: OutboxEvent): Promise<Notice[]> {
  const DAY = 86_400_000;
  let clubId: string;
  let type: NotificationType;
  let subjectId: string | null = null;
  let params: Record<string, unknown> = {};
  let managersOnly = false;
  if (
    event.type === "billing.invoice.issued" ||
    event.type === "billing.invoice.overdue" ||
    event.type === "billing.card.failed"
  ) {
    const p = DOMAIN_EVENTS["billing.invoice.issued"].parse(event.payload);
    clubId = p.clubId;
    await useClub(tx, clubId);
    const { rows } = await tx.execute<{
      number: string | null;
      kind: string;
      total_minor: string;
      currency: string;
      due_at: Date | null;
      time_zone: string;
    }>(sql`
      SELECT i.number, i.kind, i.total_minor, i.currency, i.due_at, c.time_zone
      FROM billing.invoices i JOIN public.clubs c ON c.id = i.club_id
      WHERE i.id = ${p.invoiceId}`);
    const invoice = rows[0];
    if (!invoice?.number) return [];
    subjectId = p.invoiceId;
    const level =
      event.type === "billing.invoice.overdue"
        ? DOMAIN_EVENTS["billing.invoice.overdue"].parse(event.payload).level
        : 0;
    type =
      event.type === "billing.card.failed"
        ? "billing.card.failed"
        : event.type === "billing.invoice.overdue"
          ? "billing.invoice.reminder"
          : "billing.invoice.issued";
    params = {
      number: invoice.number,
      kind: invoice.kind,
      amountMinor: Number(invoice.total_minor),
      currency: invoice.currency,
      level,
      ...(event.type === "billing.card.failed"
        ? { final: DOMAIN_EVENTS["billing.card.failed"].parse(event.payload).final ? "yes" : "no" }
        : {}),
      // The due date; for the second reminder the day the club becomes read-only.
      date: invoice.due_at
        ? new Date(new Date(invoice.due_at).getTime() + (level >= 2 ? 30 * DAY : 0)).toISOString()
        : null,
      timeZone: invoice.time_zone,
    };
  } else {
    const p = DOMAIN_EVENTS["billing.subscription.changed"].parse(event.payload);
    clubId = p.clubId;
    const types: Partial<Record<typeof p.change, NotificationType>> = {
      trial_ending: "billing.trial.ending",
      past_due: "billing.past_due",
      read_only: "billing.read_only",
      restored: "billing.restored",
    };
    const mapped = types[p.change];
    if (!mapped) return [];
    type = mapped;
    managersOnly = p.change === "trial_ending";
    await useClub(tx, clubId);
    const { rows } = await tx.execute<{ trial_ends_at: Date | null; time_zone: string }>(sql`
      SELECT s.trial_ends_at, c.time_zone FROM billing.subscriptions s
      JOIN public.clubs c ON c.id = s.club_id WHERE s.club_id = ${clubId}`);
    params = {
      date:
        p.change === "trial_ending" && rows[0]?.trial_ends_at
          ? new Date(rows[0].trial_ends_at).toISOString()
          : null,
      timeZone: rows[0]?.time_zone ?? null,
    };
  }
  const recipients = await billingRecipients(tx, clubId, managersOnly);
  return recipients.map((recipientPersonId) => ({
    recipientPersonId,
    clubId,
    type,
    subjectType: "club_billing",
    subjectId,
    about: [],
    params,
    dedupeKey: `${type}:${event.idempotencyKey}:${clubId}`,
  }));
}

/**
 * Who may admit to a group's waiting list (`group.waitlist.manage`): the
 * owners of the group or of its ancestors; the club managers when it has
 * none (P1.14).
 */
async function waitlistAdmitters(tx: Tx, clubId: string, entryId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    WITH RECURSIVE g AS (
      SELECT w.group_id AS id FROM public.group_waitlist_entries w WHERE w.id = ${entryId}
      UNION
      SELECT p.parent_group_id FROM public.groups p JOIN g ON p.id = g.id
      WHERE p.parent_group_id IS NOT NULL
    ), owners AS (
      SELECT DISTINCT o.person_id FROM public.group_owners o JOIN g ON o.group_id = g.id
      WHERE o.valid_to IS NULL
    )
    SELECT person_id FROM owners
    UNION
    SELECT h.person_id FROM (${clubHolders(clubId, "group.waitlist.manage")}) h
    WHERE NOT EXISTS (SELECT 1 FROM owners)`);
  return rows.map((r) => r.person_id);
}

/**
 * A role's name in the club's language (P1.15 A2): the club's own name, or
 * the catalogue's for a template role. Not personal data.
 */
async function roleName(tx: Tx, clubId: string, roleId: string): Promise<string> {
  const { rows } = await tx.execute<{
    names: Record<string, string> | null;
    template_key: string | null;
    scope: string;
    locale: string;
  }>(sql`
    SELECT r.names, r.template_key, r.scope, c.default_locale AS locale
    FROM public.roles r JOIN public.clubs c ON c.id = r.club_id
    WHERE r.club_id = ${clubId} AND r.id = ${roleId}`);
  const row = rows[0];
  if (!row) return "";
  return displayRoleName(row.names, row.template_key, row.scope, row.locale);
}

async function roleNameOfKey(tx: Tx, clubId: string, templateKey: string): Promise<string> {
  const { rows } = await tx.execute<{ names: Record<string, string> | null; locale: string }>(sql`
    SELECT r.names, c.default_locale AS locale
    FROM public.roles r JOIN public.clubs c ON c.id = r.club_id
    WHERE r.club_id = ${clubId} AND r.scope = 'club' AND r.template_key = ${templateKey}`);
  const row = rows[0];
  return displayRoleName(row?.names ?? null, templateKey, "club", row?.locale ?? "sv");
}

function displayRoleName(
  names: Record<string, string> | null,
  templateKey: string | null,
  scope: string,
  clubLocale: string,
): string {
  const locale = localeOf(clubLocale) ?? "sv";
  const own = names?.[locale] ?? names?.sv ?? names?.en ?? names?.nb;
  if (own) return own;
  if (!templateKey) return "";
  const group = catalogues[locale][scope === "club" ? "roles" : "functions"];
  const text = typeof group === "object" ? group[templateKey] : undefined;
  return typeof text === "string" ? text : templateKey;
}
