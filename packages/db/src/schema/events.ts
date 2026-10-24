// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6, ADR 0038): an event for some groups or the
// whole club, its audience groups, its activities (whose participants follow
// the confirmed registrations through call-ups, ADR 0036) and the
// registrations with their answers. Answers to sensitive questions are
// sealed (field-level encryption); everything has record history.

import {
  EVENT_AUDIENCES,
  EVENT_STATUSES,
  type EventAudience,
  type EventQuestion,
  type EventStatus,
  REGISTRATION_STATUSES,
  type RegistrationStatus,
  WAITLIST_MODES,
  type WaitlistMode,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activities, locations } from "./activities.ts";
import { clubRef, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";

export const events = pgTable(
  "events",
  {
    id: id(),
    clubId: clubRef(),
    title: text().notNull(),
    description: text(),
    audience: text().$type<EventAudience>().notNull(),
    status: text().$type<EventStatus>().notNull().default("draft"),
    cancelledReason: text(),
    startsAt: timestamp(tz).notNull(),
    endsAt: timestamp(tz).notNull(),
    locationId: uuid(),
    locationText: text(),
    /** Shown as written; no payments (Phase 3). */
    priceText: text(),
    /** Null: open when published. */
    registrationOpensAt: timestamp(tz),
    registrationClosesAt: timestamp(tz).notNull(),
    /** Null: the same as registrationClosesAt. */
    cancellationClosesAt: timestamp(tz),
    /** Null: unlimited. */
    capacity: integer(),
    waitlistMode: text().$type<WaitlistMode>().notNull().default("offer"),
    offerReplyHours: integer().notNull().default(24),
    /** The sign-up form (validated with EventQuestionsSchema). */
    questions: jsonb().$type<EventQuestion[]>().notNull().default([]),
    createdByPersonId: personRef(),
    ...timestamps,
  },
  (t) => [
    unique("events_club_id_unique").on(t.clubId, t.id),
    foreignKey({
      name: "events_location_fk",
      columns: [t.clubId, t.locationId],
      foreignColumns: [locations.clubId, locations.id],
    }),
    check("events_audience", oneOf(t.audience, EVENT_AUDIENCES)),
    check("events_status", oneOf(t.status, EVENT_STATUSES)),
    check("events_waitlist_mode", oneOf(t.waitlistMode, WAITLIST_MODES)),
    check("events_period", sql`${t.endsAt} > ${t.startsAt}`),
    check("events_capacity", sql`${t.capacity} IS NULL OR ${t.capacity} > 0`),
    check("events_offer_reply_hours", sql`${t.offerReplyHours} BETWEEN 1 AND 168`),
    check(
      "events_cancelled_reason",
      sql`${t.cancelledReason} IS NULL OR ${t.status} = 'cancelled'`,
    ),
    index("events_club_starts_idx").on(t.clubId, t.startsAt),
    index("events_creator_idx").on(t.createdByPersonId),
  ],
);

/** The audience groups of a group event. */
export const eventGroups = pgTable(
  "event_groups",
  {
    id: id(),
    clubId: clubRef(),
    eventId: uuid().notNull(),
    groupId: uuid().notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_groups_event_fk",
      columns: [t.clubId, t.eventId],
      foreignColumns: [events.clubId, events.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_groups_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    unique("event_groups_unique").on(t.eventId, t.groupId),
    index("event_groups_group_idx").on(t.clubId, t.groupId),
  ],
);

/** The event's activities (an activity belongs to at most one event). */
export const eventActivities = pgTable(
  "event_activities",
  {
    id: id(),
    clubId: clubRef(),
    eventId: uuid().notNull(),
    activityId: uuid().notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_activities_event_fk",
      columns: [t.clubId, t.eventId],
      foreignColumns: [events.clubId, events.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_activities_activity_fk",
      columns: [t.clubId, t.activityId],
      foreignColumns: [activities.clubId, activities.id],
    }).onDelete("cascade"),
    unique("event_activities_activity_unique").on(t.activityId),
    index("event_activities_event_idx").on(t.clubId, t.eventId),
  ],
);

export const eventRegistrations = pgTable(
  "event_registrations",
  {
    id: id(),
    clubId: clubRef(),
    eventId: uuid().notNull(),
    /** The participant. */
    personId: personRef(),
    /** The participant, or the guardian who signed them up. */
    registeredByPersonId: personRef(),
    status: text().$type<RegistrationStatus>().notNull(),
    /** Waiting-list order. */
    queuedAt: timestamp(tz).notNull().defaultNow(),
    offerExpiresAt: timestamp(tz),
    /** Answers to the non-sensitive questions, by question ID. */
    answers: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** The answers to sensitive questions as one sealed JSON value. */
    sensitiveAnswers: text(),
    /** Why an organiser moved it up out of order or removed it (organisers only). */
    decisionReason: text(),
    decidedByPersonId: uuid(),
    decidedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "event_registrations_event_fk",
      columns: [t.clubId, t.eventId],
      foreignColumns: [events.clubId, events.id],
    }).onDelete("cascade"),
    check("event_registrations_status", oneOf(t.status, REGISTRATION_STATUSES)),
    check("event_registrations_offer", sql`${t.offerExpiresAt} IS NULL OR ${t.status} = 'offered'`),
    uniqueIndex("event_registrations_open_unique")
      .on(t.eventId, t.personId)
      .where(sql`${t.status} IN ('confirmed', 'waitlisted', 'offered')`),
    // The lists and the queue of an event.
    index("event_registrations_event_idx").on(t.clubId, t.eventId, t.status, t.queuedAt),
    // "My events".
    index("event_registrations_person_idx").on(t.personId, t.eventId),
    index("event_registrations_registrant_idx").on(t.registeredByPersonId),
    // Offers to expire.
    index("event_registrations_offer_idx")
      .on(t.offerExpiresAt)
      .where(sql`${t.status} = 'offered'`),
  ],
);
