// SPDX-License-Identifier: AGPL-3.0-only
// Activities (P1.4, ADR 0034): the club's locations, recurring series and
// their materialised sessions, single activities, the groups of each, and
// `schedule_entries` (one row per activity and group, the read model of the
// calendars and "My schedule"). Times are timestamptz (UTC); a series' rules
// are local times in the club's time zone.

import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  type ActivityKind,
  type ActivityStatus,
  HOME_AWAY,
  type HomeAway,
  RESPONSE_MODES,
  type ResponseMode,
  type SeriesSlot,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
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

import { clubRef, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";

export const locations = pgTable(
  "locations",
  {
    id: id(),
    clubId: clubRef(),
    name: text().notNull(),
    street: text(),
    postalCode: text(),
    city: text(),
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    /** "Entrance B, hall 2". */
    directions: text(),
    archivedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("locations_club_id_unique").on(t.clubId, t.id),
    uniqueIndex("locations_name_unique")
      .on(t.clubId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} IS NULL`),
    check("locations_coordinates", sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`),
  ],
);

export const activitySeries = pgTable(
  "activity_series",
  {
    id: id(),
    clubId: clubRef(),
    kind: text().$type<ActivityKind>().notNull(),
    title: text().notNull(),
    notes: text(),
    leaderNotes: text(),
    locationId: uuid(),
    locationText: text(),
    /** Weekly sessions: ISO weekday, local start time, duration. */
    slots: jsonb().$type<SeriesSlot[]>().notNull(),
    startsOn: date({ mode: "string" }).notNull(),
    endsOn: date({ mode: "string" }).notNull(),
    skipDates: date({ mode: "string" })
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    skipPublicHolidays: boolean().notNull().default(false),
    /** Answers (P1.5): copied to each session, the deadline relative to its start. */
    responseMode: text().$type<ResponseMode>().notNull().default("optional"),
    respondByMinutes: integer(),
    createdByPersonId: personRef(),
    ...timestamps,
  },
  (t) => [
    unique("activity_series_club_id_unique").on(t.clubId, t.id),
    check("activity_series_response_mode", oneOf(t.responseMode, RESPONSE_MODES)),
    check(
      "activity_series_respond_by_minutes",
      sql`${t.respondByMinutes} IS NULL OR ${t.respondByMinutes} BETWEEN 0 AND 20160`,
    ),
    foreignKey({
      name: "activity_series_location_fk",
      columns: [t.clubId, t.locationId],
      foreignColumns: [locations.clubId, locations.id],
    }),
    check("activity_series_kind", oneOf(t.kind, ACTIVITY_KINDS)),
    check("activity_series_period", sql`${t.endsOn} >= ${t.startsOn}`),
    check("activity_series_length", sql`${t.endsOn} - ${t.startsOn} <= 400`),
    index("activity_series_club_idx").on(t.clubId, t.startsOn),
    index("activity_series_creator_idx").on(t.createdByPersonId),
  ],
);

export const activitySeriesGroups = pgTable(
  "activity_series_groups",
  {
    id: id(),
    clubId: clubRef(),
    seriesId: uuid().notNull(),
    groupId: uuid().notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "activity_series_groups_series_fk",
      columns: [t.clubId, t.seriesId],
      foreignColumns: [activitySeries.clubId, activitySeries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_series_groups_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    unique("activity_series_groups_unique").on(t.seriesId, t.groupId),
    index("activity_series_groups_group_idx").on(t.clubId, t.groupId),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: id(),
    clubId: clubRef(),
    seriesId: uuid(),
    /** The local date of the session in its series (matches it when the series changes). */
    occurrenceOn: date({ mode: "string" }),
    kind: text().$type<ActivityKind>().notNull(),
    title: text().notNull(),
    status: text().$type<ActivityStatus>().notNull().default("scheduled"),
    cancelledReason: text(),
    startsAt: timestamp(tz).notNull(),
    endsAt: timestamp(tz).notNull(),
    allDay: boolean().notNull().default(false),
    meetAt: timestamp(tz),
    meetPlace: text(),
    locationId: uuid(),
    locationText: text(),
    notes: text(),
    leaderNotes: text(),
    opponent: text(),
    homeAway: text().$type<HomeAway>(),
    competition: text(),
    /** Edited apart from its series: series changes leave it alone. */
    detached: boolean().notNull().default(false),
    sequence: integer().notNull().default(0),
    changedAt: timestamp(tz).notNull().defaultNow(),
    /** Answers (P1.5): none, optional or requested (by respondBy, if set). */
    responseMode: text().$type<ResponseMode>().notNull().default("optional"),
    respondBy: timestamp(tz),
    /** Only the people called up (activity_invitees) take part and answer (#19). */
    inviteesOnly: boolean().notNull().default(false),
    createdByPersonId: personRef(),
    ...timestamps,
  },
  (t) => [
    unique("activities_club_id_unique").on(t.clubId, t.id),
    check("activities_response_mode", oneOf(t.responseMode, RESPONSE_MODES)),
    foreignKey({
      name: "activities_series_fk",
      columns: [t.clubId, t.seriesId],
      foreignColumns: [activitySeries.clubId, activitySeries.id],
    }),
    foreignKey({
      name: "activities_location_fk",
      columns: [t.clubId, t.locationId],
      foreignColumns: [locations.clubId, locations.id],
    }),
    check("activities_kind", oneOf(t.kind, ACTIVITY_KINDS)),
    check("activities_status", oneOf(t.status, ACTIVITY_STATUSES)),
    check("activities_home_away", sql`${t.homeAway} IS NULL OR ${oneOf(t.homeAway, HOME_AWAY)}`),
    check("activities_period", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "activities_cancelled_reason",
      sql`${t.cancelledReason} IS NULL OR ${t.status} = 'cancelled'`,
    ),
    uniqueIndex("activities_series_occurrence_unique")
      .on(t.seriesId, t.occurrenceOn)
      .where(sql`${t.seriesId} IS NOT NULL`),
    index("activities_club_starts_idx").on(t.clubId, t.startsAt),
    index("activities_location_idx")
      .on(t.clubId, t.locationId, t.startsAt)
      .where(sql`${t.locationId} IS NOT NULL`),
    index("activities_creator_idx").on(t.createdByPersonId),
  ],
);

export const activityGroups = pgTable(
  "activity_groups",
  {
    id: id(),
    clubId: clubRef(),
    activityId: uuid().notNull(),
    groupId: uuid().notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "activity_groups_activity_fk",
      columns: [t.clubId, t.activityId],
      foreignColumns: [activities.clubId, activities.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_groups_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    unique("activity_groups_unique").on(t.activityId, t.groupId),
    index("activity_groups_group_idx").on(t.clubId, t.groupId),
  ],
);

/**
 * The read model of the calendars (ADR 0034): one row per activity and group
 * with what a calendar shows (never participants). Written in the same
 * transaction as the activity; readable in the club's context and, across
 * clubs, by members of the group and their guardians (RLS).
 */
export const scheduleEntries = pgTable(
  "schedule_entries",
  {
    id: id(),
    clubId: clubRef(),
    activityId: uuid().notNull(),
    groupId: uuid().notNull(),
    kind: text().$type<ActivityKind>().notNull(),
    title: text().notNull(),
    status: text().$type<ActivityStatus>().notNull(),
    cancelledReason: text(),
    startsAt: timestamp(tz).notNull(),
    endsAt: timestamp(tz).notNull(),
    allDay: boolean().notNull(),
    meetAt: timestamp(tz),
    /** The location's name (or the free-text place). */
    place: text(),
    changedAt: timestamp(tz).notNull(),
    responseMode: text().$type<ResponseMode>().notNull().default("optional"),
    respondBy: timestamp(tz),
    inviteesOnly: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "schedule_entries_activity_fk",
      columns: [t.clubId, t.activityId],
      foreignColumns: [activities.clubId, activities.id],
    }).onDelete("cascade"),
    unique("schedule_entries_unique").on(t.activityId, t.groupId),
    index("schedule_entries_group_idx").on(t.groupId, t.startsAt),
    index("schedule_entries_club_idx").on(t.clubId, t.startsAt),
  ],
);
