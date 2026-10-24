// SPDX-License-Identifier: AGPL-3.0-only
// Activities (P1.4, ADR 0034): locations, recurring series of trainings,
// single activities (matches, meetings), the group and club calendars and
// "My schedule". Calendar data never lists participants (ADR 0021, 0022);
// people appear only as PersonSummary (the leaders of an activity's groups
// and whose schedule an entry is).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { RESPONSE_MODES, RESPONSE_STATUSES, ResponseCountsSchema } from "./attendance.ts";

export const ACTIVITY_KINDS = ["training", "match", "meeting", "other"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_STATUSES = ["scheduled", "cancelled"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const HOME_AWAY = ["home", "away", "neutral"] as const;
export type HomeAway = (typeof HOME_AWAY)[number];

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** A series covers at most this many days (ADR 0034: fully materialised). */
export const SERIES_MAX_DAYS = 400;
/** A calendar range asked for at once. */
export const CALENDAR_MAX_DAYS = 400;

const localTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM");
const text = (max: number) => z.string().trim().min(1).max(max);
const dateRange = { from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) };

// --- Locations ---------------------------------------------------------------

export const LocationInputSchema = z
  .object({
    name: text(100),
    street: text(200).nullish(),
    postalCode: text(20).nullish(),
    city: text(100).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    directions: text(500).nullish(),
  })
  .strict()
  .openapi("LocationInput");
export type LocationInput = z.input<typeof LocationInputSchema>;

export const UpdateLocationSchema = LocationInputSchema.partial()
  .extend({ archived: z.boolean().optional() })
  .strict()
  .openapi("UpdateLocationRequest");
export type UpdateLocationInput = z.input<typeof UpdateLocationSchema>;

export const LocationSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    street: z.string().nullable(),
    postalCode: z.string().nullable(),
    city: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    directions: z.string().nullable(),
    /** An OpenStreetMap link (coordinates, or the address searched). */
    mapUrl: z.url().nullable(),
    archived: z.boolean(),
  })
  .openapi("Location");
export type Location = z.infer<typeof LocationSchema>;

export const LocationListSchema = z
  .object({ items: z.array(LocationSchema), nextCursor: z.uuid().nullable() })
  .openapi("LocationList");
export type LocationList = z.infer<typeof LocationListSchema>;

export const LocationParamsSchema = z.object({ clubId: z.uuid(), locationId: z.uuid() });
export const LocationListQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// --- Activities --------------------------------------------------------------

/** Where an activity is: a club location, a free-text address, or neither. */
const place = {
  locationId: z.uuid().nullish(),
  locationText: text(200).nullish(),
};

/** Answers (P1.5): the mode (default by kind) and a deadline. */
const answers = {
  responseMode: z.enum(RESPONSE_MODES).optional(),
  respondBy: z.iso.datetime({ offset: true }).nullish(),
};

const details = {
  title: text(120),
  notes: text(2000).nullish(),
  leaderNotes: text(2000).nullish(),
  meetPlace: text(200).nullish(),
  opponent: text(120).nullish(),
  homeAway: z.enum(HOME_AWAY).nullish(),
  competition: text(120).nullish(),
};

export const CreateActivitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    ...details,
    ...place,
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    /** All-day (the dates of startsAt and endsAt in the club's time zone count). */
    allDay: z.boolean().default(false),
    meetAt: z.iso.datetime({ offset: true }).nullish(),
    ...answers,
    /** More groups for a joint activity (the caller must manage each). */
    groupIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .openapi("CreateActivityRequest");
export type CreateActivityInput = z.input<typeof CreateActivitySchema>;

export const UpdateActivitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS).optional(),
    title: details.title.optional(),
    notes: details.notes,
    leaderNotes: details.leaderNotes,
    meetPlace: details.meetPlace,
    opponent: details.opponent,
    homeAway: details.homeAway,
    competition: details.competition,
    ...place,
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    meetAt: z.iso.datetime({ offset: true }).nullish(),
    ...answers,
  })
  .strict()
  .openapi("UpdateActivityRequest");
export type UpdateActivityInput = z.input<typeof UpdateActivitySchema>;

export const CancelActivitySchema = z
  .object({ reason: text(300).optional() })
  .strict()
  .openapi("CancelActivityRequest");
export type CancelActivityInput = z.input<typeof CancelActivitySchema>;

// --- Series --------------------------------------------------------------------

export const SeriesSlotSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startTime: localTime,
    durationMinutes: z.number().int().min(15).max(720),
  })
  .strict();
export type SeriesSlot = z.infer<typeof SeriesSlotSchema>;

/** A series' answers: the mode and a deadline before each session (minutes, up to two weeks). */
const seriesAnswers = {
  responseMode: z.enum(RESPONSE_MODES).optional(),
  respondByMinutes: z.number().int().min(0).max(20_160).nullish(),
};

const recurrence = {
  slots: z.array(SeriesSlotSchema).min(1).max(14),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  skipDates: z.array(z.iso.date()).max(200).default([]),
  skipPublicHolidays: z.boolean().default(false),
};

export const CreateSeriesSchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS).default("training"),
    title: details.title,
    notes: details.notes,
    leaderNotes: details.leaderNotes,
    ...place,
    ...recurrence,
    ...seriesAnswers,
    groupIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict()
  .refine((v) => v.endsOn >= v.startsOn, { message: "endsOn before startsOn", path: ["endsOn"] })
  .openapi("CreateSeriesRequest");
export type CreateSeriesInput = z.input<typeof CreateSeriesSchema>;

/** Changes to a series from a date (default today): its future, non-detached sessions follow. */
export const UpdateSeriesSchema = z
  .object({
    from: z.iso.date().optional(),
    kind: z.enum(ACTIVITY_KINDS).optional(),
    title: details.title.optional(),
    notes: details.notes,
    leaderNotes: details.leaderNotes,
    ...place,
    slots: recurrence.slots.optional(),
    endsOn: z.iso.date().optional(),
    skipDates: z.array(z.iso.date()).max(200).optional(),
    skipPublicHolidays: z.boolean().optional(),
    ...seriesAnswers,
  })
  .strict()
  .openapi("UpdateSeriesRequest");
export type UpdateSeriesInput = z.input<typeof UpdateSeriesSchema>;

/** "This and following": the series ends before the session; a new one starts with the changes. */
export const SplitSeriesSchema = UpdateSeriesSchema.omit({ from: true })
  .extend({ activityId: z.uuid() })
  .strict()
  .openapi("SplitSeriesRequest");
export type SplitSeriesInput = z.input<typeof SplitSeriesSchema>;

export const SeriesPreviewSchema = z
  .object({
    ...recurrence,
  })
  .strict()
  .refine((v) => v.endsOn >= v.startsOn, { message: "endsOn before startsOn", path: ["endsOn"] })
  .openapi("SeriesPreviewRequest");
export type SeriesPreviewInput = z.input<typeof SeriesPreviewSchema>;

export const SeriesPreviewResultSchema = z
  .object({
    timeZone: z.string(),
    sessions: z.array(
      z.object({
        date: z.iso.date(),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
      }),
    ),
    /** Dates of the pattern left out: the skipped dates and public holidays that fell on it. */
    skipped: z.array(z.object({ date: z.iso.date(), holiday: z.boolean() })),
  })
  .openapi("SeriesPreview");
export type SeriesPreviewResult = z.infer<typeof SeriesPreviewResultSchema>;

// --- Responses -------------------------------------------------------------------

export const ActivityGroupRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const ActivitySchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    /** The club's IANA time zone: local times and all-day dates are in it. */
    timeZone: z.string(),
    seriesId: z.uuid().nullable(),
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string(),
    status: z.enum(ACTIVITY_STATUSES),
    cancelledReason: z.string().nullable(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    allDay: z.boolean(),
    meetAt: z.iso.datetime({ offset: true }).nullable(),
    meetPlace: z.string().nullable(),
    location: LocationSchema.nullable(),
    locationText: z.string().nullable(),
    notes: z.string().nullable(),
    /** Only for those who manage the activity. */
    leaderNotes: z.string().nullable().optional(),
    opponent: z.string().nullable(),
    homeAway: z.enum(HOME_AWAY).nullable(),
    competition: z.string().nullable(),
    /** Edited apart from its series. */
    detached: z.boolean(),
    /** Increases with every change a calendar must show (P1.11). */
    sequence: z.number().int(),
    changedAt: z.iso.datetime({ offset: true }),
    groups: z.array(ActivityGroupRefSchema),
    canManage: z.boolean(),
    /** Answers (P1.5). */
    responseMode: z.enum(RESPONSE_MODES).optional(),
    respondBy: z.iso.datetime({ offset: true }).nullable().optional(),
    /** Only those called up take part and answer (#19). */
    inviteesOnly: z.boolean().optional(),
    /** For those who manage it, in the group calendar. */
    responseCounts: ResponseCountsSchema.optional(),
  })
  .openapi("Activity");
export type Activity = z.infer<typeof ActivitySchema>;

export const ActivityDetailSchema = ActivitySchema.extend({
  /** The leaders of its groups the viewer may see (never participants). */
  leaders: z.array(PersonSummarySchema),
}).openapi("ActivityDetail");
export type ActivityDetail = z.infer<typeof ActivityDetailSchema>;

export const ActivityPageSchema = z
  .object({ items: z.array(ActivitySchema), nextCursor: z.uuid().nullable() })
  .openapi("ActivityPage");
export type ActivityPage = z.infer<typeof ActivityPageSchema>;

export const GroupCalendarSchema = ActivityPageSchema.extend({
  /** Whether the viewer may add activities and series to the group. */
  canManage: z.boolean(),
  /** Whether the viewer may read the group's attendance summary (P1.5). */
  canReadAttendance: z.boolean(),
}).openapi("GroupCalendar");
export type GroupCalendar = z.infer<typeof GroupCalendarSchema>;

export const SeriesSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    timeZone: z.string(),
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string(),
    notes: z.string().nullable(),
    leaderNotes: z.string().nullable().optional(),
    location: LocationSchema.nullable(),
    locationText: z.string().nullable(),
    slots: z.array(SeriesSlotSchema),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    skipDates: z.array(z.iso.date()),
    skipPublicHolidays: z.boolean(),
    responseMode: z.enum(RESPONSE_MODES).optional(),
    respondByMinutes: z.number().int().nullable().optional(),
    groups: z.array(ActivityGroupRefSchema),
    /** Sessions it has now (scheduled and cancelled). */
    sessions: z.number().int(),
    canManage: z.boolean(),
  })
  .openapi("ActivitySeries");
export type Series = z.infer<typeof SeriesSchema>;

export const SeriesChangeResultSchema = z
  .object({
    series: SeriesSchema,
    created: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
  })
  .openapi("ActivitySeriesChange");
export type SeriesChangeResult = z.infer<typeof SeriesChangeResultSchema>;

export const CalendarQuerySchema = z.object({
  ...dateRange,
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

export const ClubCalendarQuerySchema = CalendarQuerySchema.extend({
  groupId: z.uuid().optional(),
  locationId: z.uuid().optional(),
});
export type ClubCalendarQuery = z.infer<typeof ClubCalendarQuerySchema>;

export const LocationConflictsQuerySchema = z.object(dateRange);

export const LocationConflictsSchema = z
  .object({
    conflicts: z.array(z.object({ first: ActivitySchema, second: ActivitySchema })),
  })
  .openapi("LocationConflicts");
export type LocationConflicts = z.infer<typeof LocationConflictsSchema>;

export const ScheduleQuerySchema = z.object({
  ...dateRange,
  /** Only this person (me or a ward whose schedule I may see). */
  personId: z.uuid().optional(),
  clubId: z.uuid().optional(),
  /** Entries changed after this time are marked `changed`. */
  changedSince: z.iso.datetime({ offset: true }).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ScheduleQuery = z.infer<typeof ScheduleQuerySchema>;

export const ScheduleEntrySchema = z
  .object({
    activityId: z.uuid(),
    club: z.object({ id: z.uuid(), name: z.string(), timeZone: z.string() }),
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string(),
    status: z.enum(ACTIVITY_STATUSES),
    cancelledReason: z.string().nullable(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    allDay: z.boolean(),
    meetAt: z.iso.datetime({ offset: true }).nullable(),
    place: z.string().nullable(),
    groups: z.array(ActivityGroupRefSchema),
    /** Whose schedule it is on (me and/or my wards). */
    people: z.array(PersonSummarySchema),
    changed: z.boolean(),
    /** The event the activity belongs to (P1.6); its sign-up is on the event. */
    eventId: z.uuid().nullable().optional(),
    changedAt: z.iso.datetime({ offset: true }),
    /** Answers (P1.5). */
    responseMode: z.enum(RESPONSE_MODES).optional(),
    respondBy: z.iso.datetime({ offset: true }).nullable().optional(),
    /** Per person in `people`: their answer and whether the viewer may give it. */
    responses: z
      .array(
        z.object({
          personId: z.uuid(),
          status: z.enum(RESPONSE_STATUSES).nullable(),
          canRespond: z.boolean(),
        }),
      )
      .optional(),
  })
  .openapi("ScheduleEntry");
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const SchedulePageSchema = z
  .object({
    items: z.array(ScheduleEntrySchema),
    nextCursor: z.uuid().nullable(),
    /** The people this schedule covers (me and the wards whose schedule I may see). */
    people: z.array(PersonSummarySchema),
  })
  .openapi("SchedulePage");
export type SchedulePage = z.infer<typeof SchedulePageSchema>;

export const ActivityParamsSchema = z.object({ activityId: z.uuid() });
export const SeriesParamsSchema = z.object({ seriesId: z.uuid() });

/** An OpenStreetMap link for a location (no third-party script, no embedded map). */
export function mapUrlOf(location: {
  latitude: number | null;
  longitude: number | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
}): string | null {
  if (location.latitude !== null && location.longitude !== null) {
    return `https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=17/${location.latitude}/${location.longitude}`;
  }
  const query = [location.street, location.postalCode, location.city].filter(Boolean).join(", ");
  return query ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}` : null;
}
