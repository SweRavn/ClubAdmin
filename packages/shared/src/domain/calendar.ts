// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions (P1.11, ADR 0021, ADR 0044): managing one's feeds,
// and the public answer links in feed events.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { RESPONSE_STATUSES } from "./attendance.ts";
import { CALENDAR_FEED_SCOPES } from "./core.ts";

const label = z.string().trim().min(1).max(60);

export const CalendarFeedParamsSchema = z.object({ feedId: z.uuid() });

export const CreateMyScheduleFeedSchema = z
  .object({
    /** The caller and wards whose schedule the caller sees; empty or missing: all of them, also later ones. */
    personIds: z.array(z.uuid()).max(20).optional(),
    label: label.optional(),
  })
  .strict()
  .openapi("CreateMyScheduleFeed");
export type CreateMyScheduleFeedInput = z.infer<typeof CreateMyScheduleFeedSchema>;

export const CreateScopedFeedSchema = z
  .object({ label: label.optional() })
  .strict()
  .openapi("CreateScopedFeed");
export type CreateScopedFeedInput = z.infer<typeof CreateScopedFeedSchema>;

export const UpdateCalendarFeedSchema = z
  .object({
    label: label.nullable().optional(),
    personIds: z.array(z.uuid()).max(20).optional(),
  })
  .strict()
  .openapi("UpdateCalendarFeed");
export type UpdateCalendarFeedInput = z.infer<typeof UpdateCalendarFeedSchema>;

export const CalendarFeedSchema = z
  .object({
    id: z.uuid(),
    scope: z.enum(CALENDAR_FEED_SCOPES),
    club: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    group: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    /** `my_schedule`: the chosen people; empty with `everyone`. */
    people: z.array(PersonSummarySchema),
    /** `my_schedule` without a list: me and every ward whose schedule I see. */
    everyone: z.boolean(),
    label: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastFetchedAt: z.iso.datetime().nullable(),
  })
  .openapi("CalendarFeed");
export type CalendarFeed = z.infer<typeof CalendarFeedSchema>;

export const CalendarFeedListSchema = z
  .object({ items: z.array(CalendarFeedSchema), max: z.number().int() })
  .openapi("CalendarFeedList");
export type CalendarFeedList = z.infer<typeof CalendarFeedListSchema>;

/** A new or regenerated feed: its URLs are shown once and never again. */
export const CalendarFeedCreatedSchema = z
  .object({
    feed: CalendarFeedSchema,
    /** For Apple Calendar and Outlook (subscribes). */
    webcalUrl: z.string(),
    /** For Google Calendar ("From URL") and others. */
    httpsUrl: z.string(),
  })
  .openapi("CalendarFeedCreated");
export type CalendarFeedCreated = z.infer<typeof CalendarFeedCreatedSchema>;

export const CalendarAnswerParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
});

/** What an answer link will do (GET never changes anything). */
export const CalendarAnswerSchema = z
  .object({
    activity: z.object({
      title: z.string(),
      startsAt: z.iso.datetime(),
      place: z.string().nullable(),
      clubName: z.string(),
      timeZone: z.string(),
      cancelled: z.boolean(),
    }),
    /** The first name of the person answered for (initials when protected, decision 8). */
    personName: z.string(),
    status: z.enum(RESPONSE_STATUSES),
    currentAnswer: z.enum(RESPONSE_STATUSES).nullable(),
    /** Answers are open; after the deadline only not_attending is taken. */
    open: z.boolean(),
    deadlinePassed: z.boolean(),
    respondBy: z.iso.datetime().nullable(),
  })
  .openapi("CalendarAnswer");
export type CalendarAnswer = z.infer<typeof CalendarAnswerSchema>;

export const CalendarAnswerResultSchema = z
  .object({ status: z.enum(RESPONSE_STATUSES) })
  .openapi("CalendarAnswerResult");
