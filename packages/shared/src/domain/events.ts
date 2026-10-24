// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6, ADR 0038): a sign-up container for groups or the whole club, with a form of
// typed questions, deadlines, a capacity and a waiting list. Its activities
// get their participants from the confirmed registrations through call-ups
// (ADR 0036). People appear only as PersonSummary through the presenter;
// answers to sensitive questions are sealed and shown only to organisers
// and to the participant's guardians with see_medical.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  ActivityGroupRefSchema,
  LocationSchema,
} from "./activities.ts";

export const EVENT_AUDIENCES = ["groups", "club"] as const;
export type EventAudience = (typeof EVENT_AUDIENCES)[number];

/** The enum may grow (ADR 0029). */
export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** What happens when the event is full: refuse, move the next up, or offer the place. */
export const WAITLIST_MODES = ["none", "auto", "offer"] as const;
export type WaitlistMode = (typeof WAITLIST_MODES)[number];

/** The enum may grow (ADR 0029). */
export const REGISTRATION_STATUSES = [
  "confirmed",
  "waitlisted",
  "offered",
  "cancelled",
  "declined",
  "expired",
  "removed",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Registrations that hold a place or a place in the queue. */
export const OPEN_REGISTRATION_STATUSES = ["confirmed", "waitlisted", "offered"] as const;

export const QUESTION_TYPES = [
  "short_text",
  "long_text",
  "choice",
  "choices",
  "number",
  "yes_no",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const EVENT_QUESTIONS_MAX = 20;
export const EVENT_ACTIVITIES_MAX = 20;
/** Answers to sensitive questions are deleted this many days after the event ends. */
export const SENSITIVE_ANSWERS_RETENTION_DAYS = 30;
export const DEFAULT_OFFER_REPLY_HOURS = 24;

const text = (max: number) => z.string().trim().min(1).max(max);
const time = z.iso.datetime({ offset: true });

// --- Questions and answers ------------------------------------------------------------

export const EventQuestionSchema = z
  .object({
    /** Stable within the event: answers are stored by it. */
    id: z.string().regex(/^[a-z0-9_-]{1,20}$/),
    type: z.enum(QUESTION_TYPES),
    label: text(200),
    required: z.boolean().default(false),
    /** Health, allergies, medication: sealed, organisers and see_medical only. */
    sensitive: z.boolean().default(false),
    options: z.array(text(100)).min(2).max(20).optional(),
  })
  .strict()
  .refine(
    (q) =>
      q.type === "choice" || q.type === "choices"
        ? q.options !== undefined && new Set(q.options).size === q.options.length
        : q.options === undefined,
    { message: "options are required (and unique) for choice questions only", path: ["options"] },
  )
  .openapi("EventQuestion");
export type EventQuestion = z.infer<typeof EventQuestionSchema>;

export const EventQuestionsSchema = z
  .array(EventQuestionSchema)
  .max(EVENT_QUESTIONS_MAX)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, {
    message: "question IDs must be unique",
  });

export type AnswerValue = string | number | boolean | string[];
export type Answers = Record<string, AnswerValue>;

const answerSchemaFor = (q: EventQuestion): z.ZodType<AnswerValue> => {
  switch (q.type) {
    case "short_text":
      return text(200);
    case "long_text":
      return text(2000);
    case "choice":
      return z.enum(q.options as [string, ...string[]]);
    case "choices":
      return z
        .array(z.enum(q.options as [string, ...string[]]))
        .min(1)
        .refine((v) => new Set(v).size === v.length, { message: "duplicate choice" });
    case "number":
      return z.number().finite().min(-1_000_000).max(1_000_000);
    case "yes_no":
      return z.boolean();
  }
};

/**
 * Validates answers against an event's questions: unknown IDs are refused,
 * required questions must be answered, empty answers are left out.
 */
export function answersSchemaFor(questions: readonly EventQuestion[]): z.ZodType<Answers> {
  const shape: Record<string, z.ZodType> = {};
  for (const q of questions) {
    shape[q.id] = q.required ? answerSchemaFor(q) : answerSchemaFor(q).optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<Answers>;
}

/** Splits answers into the stored (plain) and the sealed (sensitive) part. */
export function splitAnswers(
  questions: readonly EventQuestion[],
  answers: Answers,
): { plain: Answers; sensitive: Answers } {
  const sensitiveIds = new Set(questions.filter((q) => q.sensitive).map((q) => q.id));
  const plain: Answers = {};
  const sensitive: Answers = {};
  for (const [id, value] of Object.entries(answers)) {
    (sensitiveIds.has(id) ? sensitive : plain)[id] = value;
  }
  return { plain, sensitive };
}

// --- Requests ---------------------------------------------------------------------------

export const EventParamsSchema = z.object({ eventId: z.uuid() });
export const RegistrationParamsSchema = z.object({ eventId: z.uuid(), personId: z.uuid() });

/** A session created together with the event (a cup match, a camp day). */
export const EventActivityInputSchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    title: text(120),
    startsAt: time,
    endsAt: time,
    locationId: z.uuid().nullish(),
    locationText: text(200).nullish(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

const eventFields = {
  title: text(200),
  description: text(4000).nullish(),
  startsAt: time,
  endsAt: time,
  locationId: z.uuid().nullish(),
  locationText: text(200).nullish(),
  /** Shown as written; no payments (Phase 3). */
  priceText: text(100).nullish(),
  /** Null: open when published. */
  registrationOpensAt: time.nullish(),
  registrationClosesAt: time,
  /** Null: the same as registrationClosesAt. */
  cancellationClosesAt: time.nullish(),
  /** Null: unlimited. */
  capacity: z.number().int().min(1).max(10_000).nullish(),
  waitlistMode: z.enum(WAITLIST_MODES).optional(),
  offerReplyHours: z.number().int().min(1).max(168).optional(),
  questions: EventQuestionsSchema.optional(),
};

const periodOk = (v: { startsAt?: string | undefined; endsAt?: string | undefined }) =>
  v.startsAt === undefined ||
  v.endsAt === undefined ||
  Date.parse(v.endsAt) > Date.parse(v.startsAt);

export const CreateEventSchema = z
  .object({
    ...eventFields,
    audience: z.enum(EVENT_AUDIENCES),
    /** The audience groups (audience "groups"; the caller must manage each). */
    groupIds: z.array(z.uuid()).max(20).default([]),
    /** Sessions created with the event, in the audience groups. */
    activities: z.array(EventActivityInputSchema).max(EVENT_ACTIVITIES_MAX).default([]),
    /** Publish at once (default: a draft only organisers see). */
    publish: z.boolean().default(false),
  })
  .strict()
  .refine(periodOk, { message: "endsAt must be after startsAt", path: ["endsAt"] })
  .refine((v) => (v.audience === "groups" ? v.groupIds.length > 0 : v.groupIds.length === 0), {
    message: "groupIds are required for a group event and not allowed for a club event",
    path: ["groupIds"],
  })
  .openapi("CreateEventRequest");
export type CreateEventInput = z.input<typeof CreateEventSchema>;

export const UpdateEventSchema = z
  .object({
    title: eventFields.title,
    description: eventFields.description,
    startsAt: eventFields.startsAt,
    endsAt: eventFields.endsAt,
    locationId: eventFields.locationId,
    locationText: eventFields.locationText,
    priceText: eventFields.priceText,
    registrationOpensAt: eventFields.registrationOpensAt,
    registrationClosesAt: eventFields.registrationClosesAt,
    cancellationClosesAt: eventFields.cancellationClosesAt,
    capacity: eventFields.capacity,
    waitlistMode: z.enum(WAITLIST_MODES),
    offerReplyHours: z.number().int().min(1).max(168),
    questions: EventQuestionsSchema,
  })
  .partial()
  .strict()
  .refine(periodOk, { message: "endsAt must be after startsAt", path: ["endsAt"] })
  .openapi("UpdateEventRequest");
export type UpdateEventInput = z.input<typeof UpdateEventSchema>;

export const CancelEventSchema = z
  .object({ reason: text(300).nullish() })
  .strict()
  .openapi("CancelEventRequest");

export const SetEventActivitiesSchema = z
  .object({ activityIds: z.array(z.uuid()).max(EVENT_ACTIVITIES_MAX) })
  .strict()
  .openapi("SetEventActivitiesRequest");

export const RegisterSchema = z
  .object({ answers: z.record(z.string(), z.unknown()).default({}) })
  .strict()
  .openapi("RegisterRequest");
export type RegisterInput = z.input<typeof RegisterSchema>;

export const RegistrationDecisionSchema = z
  .object({ reason: text(300) })
  .strict()
  .openapi("RegistrationDecisionRequest");

export const EventListQuerySchema = z.object({
  from: time.optional(),
  to: time.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type EventListQuery = z.infer<typeof EventListQuerySchema>;

export const RegistrationListQuerySchema = z.object({
  status: z.enum(REGISTRATION_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type RegistrationListQuery = z.infer<typeof RegistrationListQuerySchema>;

export const RegistrationExportQuerySchema = z.object({
  sensitive: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// --- Responses ----------------------------------------------------------------------------

const AnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);

export const EventCountsSchema = z
  .object({
    confirmed: z.number().int(),
    offered: z.number().int(),
    waiting: z.number().int(),
    /** Null when the capacity is unlimited. */
    placesLeft: z.number().int().nullable(),
  })
  .openapi("EventCounts");
export type EventCounts = z.infer<typeof EventCountsSchema>;

export const EventSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    timeZone: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    audience: z.enum(EVENT_AUDIENCES),
    groups: z.array(ActivityGroupRefSchema),
    status: z.enum(EVENT_STATUSES),
    cancelledReason: z.string().nullable(),
    startsAt: time,
    endsAt: time,
    location: LocationSchema.nullable(),
    locationText: z.string().nullable(),
    priceText: z.string().nullable(),
    registrationOpensAt: time.nullable(),
    registrationClosesAt: time,
    cancellationClosesAt: time.nullable(),
    capacity: z.number().int().nullable(),
    waitlistMode: z.enum(WAITLIST_MODES),
    offerReplyHours: z.number().int(),
    questions: z.array(EventQuestionSchema),
    counts: EventCountsSchema,
    /** Sign-up is open now. */
    open: z.boolean(),
    canManage: z.boolean(),
    activities: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(ACTIVITY_KINDS),
        title: z.string(),
        status: z.enum(ACTIVITY_STATUSES),
        startsAt: time,
        endsAt: time,
      }),
    ),
  })
  .openapi("Event");
export type Event = z.infer<typeof EventSchema>;

export const RegistrationSchema = z
  .object({
    person: PersonSummarySchema,
    status: z.enum(REGISTRATION_STATUSES),
    /** Place on the waiting list (1 = next), for waitlisted registrations. */
    position: z.number().int().nullable(),
    queuedAt: time,
    offerExpiresAt: time.nullable(),
    answers: AnswersSchema,
    /** Only for organisers and the participant's guardians with see_medical. */
    sensitiveAnswers: AnswersSchema.optional(),
    registeredBy: PersonSummarySchema.nullable(),
    /** Organisers only. */
    decisionReason: z.string().nullable().optional(),
    updatedAt: time,
  })
  .openapi("EventRegistration");
export type Registration = z.infer<typeof RegistrationSchema>;

export const EventDetailSchema = EventSchema.extend({
  /** The caller and the wards they may sign up or see. */
  mine: z.array(
    z.object({
      person: PersonSummarySchema,
      registration: RegistrationSchema.nullable(),
      canRegister: z.boolean(),
    }),
  ),
  /** Confirmed participants the viewer may see (null: names not shown to this viewer). */
  participants: z.array(PersonSummarySchema).nullable(),
}).openapi("EventDetail");
export type EventDetail = z.infer<typeof EventDetailSchema>;

export const EventPageSchema = z
  .object({ items: z.array(EventSchema), nextCursor: z.uuid().nullable() })
  .openapi("EventPage");
export type EventPage = z.infer<typeof EventPageSchema>;

export const RegistrationListSchema = z
  .object({
    items: z.array(RegistrationSchema),
    nextCursor: z.uuid().nullable(),
    counts: EventCountsSchema,
  })
  .openapi("EventRegistrationList");
export type RegistrationList = z.infer<typeof RegistrationListSchema>;

export const MyEventsSchema = z
  .object({
    items: z.array(
      z.object({
        event: EventSchema,
        people: z.array(
          z.object({
            person: PersonSummarySchema,
            status: z.enum(REGISTRATION_STATUSES).nullable(),
            position: z.number().int().nullable(),
            canRegister: z.boolean(),
          }),
        ),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("MyEvents");
export type MyEvents = z.infer<typeof MyEventsSchema>;
