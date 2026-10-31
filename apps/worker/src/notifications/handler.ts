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
