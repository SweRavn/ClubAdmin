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
import {
  DOMAIN_EVENTS,
  type DomainEventType,
  NOTICE_HORIZON_DAYS,
  NOTICE_LEAD_HOURS,
  type NotificationType,
} from "@clubadmin/shared";

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
      ...WAITLIST_EVENTS,
      "club.privacy_policy.published",
      "privacy.export.ready",
      "privacy.erasure.scheduled",
      "privacy.erasure.blocked",
      "calendar.feed.revoked",
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
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT DISTINCT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role IN ('club_manager', 'registrar')
              AND valid_to IS NULL AND person_id <> ${personId}`);
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
        case "assignment.ended": {
          const { clubId, personId, kind, groupId } = DOMAIN_EVENTS["assignment.ended"].parse(
            event.payload,
          );
          await useClub(tx, clubId);
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role = 'club_manager' AND valid_to IS NULL
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
            group_name: string;
            time_zone: string;
          }>(sql`
            SELECT w.person_id, w.requested_by_person_id, w.closed_reason, w.offer_expires_at,
              g.name AS group_name, c.time_zone
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
        // Calendar subscriptions (P1.11): the owner is told when the system
        // revoked a feed (unused for a year, access lost); not when they
        // removed or replaced it themselves.
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
