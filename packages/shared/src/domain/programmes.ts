// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9, ADR 0054): a programme groups activities
// and duty shifts (a cup, a camp, a match day); a template keeps them with
// relative days and wall-clock times in the club's time zone, group slots
// and places by reference, and no people. Laying a template out is a
// preview, then one transaction.

import { z } from "../zod.ts";
import { ACTIVITY_KINDS, HOME_AWAY } from "./activities.ts";
import { RESPONSE_MODES } from "./attendance.ts";
import { TRANSPORT_MODES } from "./carpool.ts";
import { DUTY_SHIFT_MAX_NEEDED } from "./duties.ts";
import { EVENT_AUDIENCES, EventQuestionsSchema, WAITLIST_MODES } from "./events.ts";

/** A template holds at most this many items (activities and shifts). */
export const PROGRAMME_TEMPLATE_ITEMS_MAX = 300;
/** A template spans at most this many days (day offsets 0–30). */
export const PROGRAMME_DAYS_MAX = 31;
/** A group's activities saved as a template cover at most this many days. */
export const PROGRAMME_RANGE_DAYS_MAX = 31;
export const PROGRAMME_ITEM_KINDS = ["activity", "duty_shift"] as const;
export type ProgrammeItemKind = (typeof PROGRAMME_ITEM_KINDS)[number];

/** Warnings never block laying out; refusals do (ADR 0054 decision 9). */
export const PROGRAMME_WARNINGS = [
  "location_conflict",
  "slot_without_group",
  "past_date",
  "item_without_group",
] as const;
export const PROGRAMME_REFUSALS = [
  "location_archived",
  "duty_type_archived",
  "duty_alone_with_children_forbidden",
  "group_not_found",
  "group_archived",
  "activity_without_group",
  "not_allowed",
] as const;

const wallClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dayOffset = z
  .number()
  .int()
  .min(0)
  .max(PROGRAMME_DAYS_MAX - 1);
const slotKey = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

// --- Templates --------------------------------------------------------------------

export const ProgrammeSlotSchema = z
  .object({
    key: slotKey,
    label: text(60),
    /** The group the slot maps to by default (if it still exists and is not archived). */
    defaultGroupId: z.uuid().nullable(),
  })
  .openapi("ProgrammeSlot");
export type ProgrammeSlot = z.infer<typeof ProgrammeSlotSchema>;

/**
 * The event laid out with the programme (as a draft): sign-up opens and
 * closes as days before the first day.
 */
export const ProgrammeEventSettingsSchema = z
  .object({
    title: text(200),
    description: z.string().trim().max(4000).nullable().default(null),
    audience: z.enum(EVENT_AUDIENCES),
    capacity: z.number().int().min(1).max(10_000).nullable().default(null),
    waitlistMode: z.enum(WAITLIST_MODES).nullable().default(null),
    questions: EventQuestionsSchema.default([]),
    priceText: z.string().trim().max(100).nullable().default(null),
    /** Null: open when published. */
    opensDaysBefore: z.number().int().min(0).max(365).nullable().default(null),
    /** Null: the first day. */
    closesDaysBefore: z.number().int().min(0).max(365).nullable().default(null),
  })
  .openapi("ProgrammeEventSettings");
export type ProgrammeEventSettings = z.infer<typeof ProgrammeEventSettingsSchema>;

/**
 * An item of a template: an activity, or a duty shift (on an activity item
 * through `parentRef`, or on its own). `ref` names the item within the
 * request (a stored item's ID, or any short text for a new one).
 */
export const ProgrammeItemInputSchema = z
  .object({
    ref: z.string().min(1).max(40),
    kind: z.enum(PROGRAMME_ITEM_KINDS),
    parentRef: z.string().min(1).max(40).nullable().default(null),
    dayOffset,
    startTime: wallClock,
    endDayOffset: dayOffset,
    endTime: wallClock,
    slotKeys: z.array(slotKey).max(20).default([]),
    title: text(200),
    // Activities.
    activityKind: z.enum(ACTIVITY_KINDS).nullable().default(null),
    kindLabel: z.string().trim().min(1).max(60).nullable().default(null),
    notes: z.string().trim().max(2000).nullable().default(null),
    locationId: z.uuid().nullable().default(null),
    locationText: z.string().trim().max(200).nullable().default(null),
    meetMinutesBefore: z.number().int().min(0).max(600).nullable().default(null),
    meetPlace: z.string().trim().max(200).nullable().default(null),
    transportMode: z.enum(TRANSPORT_MODES).nullable().default(null),
    homeAway: z.enum(HOME_AWAY).nullable().default(null),
    opponent: z.string().trim().max(120).nullable().default(null),
    responseMode: z.enum(RESPONSE_MODES).nullable().default(null),
    // Duty shifts.
    dutyTypeId: z.uuid().nullable().default(null),
    needed: z.number().int().min(1).max(DUTY_SHIFT_MAX_NEEDED).nullable().default(null),
  })
  .strict()
  .openapi("ProgrammeItemInput");
export type ProgrammeItemInput = z.input<typeof ProgrammeItemInputSchema>;
export type ProgrammeItemValues = z.infer<typeof ProgrammeItemInputSchema>;

export const ProgrammeItemSchema = ProgrammeItemInputSchema.omit({ ref: true, parentRef: true })
  .extend({ id: z.uuid(), parentItemId: z.uuid().nullable() })
  .openapi("ProgrammeItem");
export type ProgrammeItem = z.infer<typeof ProgrammeItemSchema>;

export const ProgrammeEditionSchema = z
  .object({
    programmeId: z.uuid(),
    title: z.string(),
    edition: z.string().nullable(),
    firstDay: z.iso.date(),
  })
  .openapi("ProgrammeEdition");

export const ProgrammeTemplateSummarySchema = z
  .object({
    id: z.uuid(),
    /** Null: the club's template. */
    groupId: z.uuid().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    dayCount: z.number().int(),
    itemCount: z.number().int(),
    hasEvent: z.boolean(),
    archived: z.boolean(),
    /** The caller may change it (else only lay it out). */
    canManage: z.boolean(),
  })
  .openapi("ProgrammeTemplateSummary");
export type ProgrammeTemplateSummary = z.infer<typeof ProgrammeTemplateSummarySchema>;

export const ProgrammeTemplateSchema = ProgrammeTemplateSummarySchema.extend({
  eventSettings: ProgrammeEventSettingsSchema.nullable(),
  slots: z.array(ProgrammeSlotSchema),
  items: z.array(ProgrammeItemSchema),
  /** Programmes laid out from it, newest first (at most 20). */
  editions: z.array(ProgrammeEditionSchema),
}).openapi("ProgrammeTemplate");
export type ProgrammeTemplate = z.infer<typeof ProgrammeTemplateSchema>;

export const ProgrammeTemplateListSchema = z
  .object({ items: z.array(ProgrammeTemplateSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("ProgrammeTemplateList");

export const ProgrammeTemplateQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only this group's templates and the club's. */
  groupId: z.uuid().optional(),
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

/** Where a template is saved from (ADR 0054 decision 8). */
export const ProgrammeTemplateSourceSchema = z.union([
  z.object({ programmeId: z.uuid() }).strict(),
  z.object({ eventId: z.uuid() }).strict(),
  z.object({ groupId: z.uuid(), from: z.iso.date(), to: z.iso.date() }).strict(),
  z.object({ activityId: z.uuid() }).strict(),
]);
export type ProgrammeTemplateSource = z.infer<typeof ProgrammeTemplateSourceSchema>;

export const CreateProgrammeTemplateSchema = z
  .object({
    name: text(120),
    description: z.string().trim().max(2000).nullish(),
    /** The group whose template it is; null: the club's (club managers). */
    groupId: z.uuid().nullable(),
    source: ProgrammeTemplateSourceSchema,
  })
  .strict()
  .openapi("CreateProgrammeTemplateRequest");
export type CreateProgrammeTemplateInput = z.input<typeof CreateProgrammeTemplateSchema>;

/** Changes; `slots` and `items` replace the template's whole lists when given. */
export const UpdateProgrammeTemplateSchema = z
  .object({
    name: text(120),
    description: z.string().trim().max(2000).nullable(),
    dayCount: z.number().int().min(1).max(PROGRAMME_DAYS_MAX),
    eventSettings: ProgrammeEventSettingsSchema.nullable(),
    slots: z.array(ProgrammeSlotSchema).max(20),
    items: z.array(ProgrammeItemInputSchema).max(PROGRAMME_TEMPLATE_ITEMS_MAX),
    archived: z.boolean(),
  })
  .partial()
  .strict()
  .openapi("UpdateProgrammeTemplateRequest");
export type UpdateProgrammeTemplateInput = z.input<typeof UpdateProgrammeTemplateSchema>;

export const ProgrammeTemplateParamsSchema = z.object({ clubId: z.uuid(), templateId: z.uuid() });
export const ProgrammeParamsSchema = z.object({ clubId: z.uuid(), programmeId: z.uuid() });

// --- Laying out -------------------------------------------------------------------

export const ApplyProgrammeSchema = z
  .object({
    firstDay: z.iso.date(),
    /** Every slot to groups of the club (default: the slot's default group). */
    slots: z.record(slotKey, z.array(z.uuid()).max(20)).default({}),
    /** Places to replace (an archived one must be). */
    locations: z.record(z.uuid(), z.uuid()).default({}),
    /** Default: the template's name. */
    title: z.string().trim().min(1).max(200).nullish(),
    /** Default: the first day's year. */
    edition: z.string().trim().min(1).max(60).nullish(),
  })
  .strict()
  .openapi("ApplyProgrammeRequest");
export type ApplyProgrammeInput = z.input<typeof ApplyProgrammeSchema>;

export const ProgrammeNoticeSchema = z
  .object({
    code: z.string(),
    /** The template item it is about (or the source's). */
    itemId: z.string().nullable(),
    slotKey: z.string().nullable(),
    groupId: z.uuid().nullable(),
    locationId: z.uuid().nullable(),
    /** A location conflict: the existing activity. */
    activityId: z.uuid().nullable(),
  })
  .openapi("ProgrammeNotice");
export type ProgrammeNotice = z.infer<typeof ProgrammeNoticeSchema>;

export const ProgrammePreviewItemSchema = z
  .object({
    itemId: z.string(),
    kind: z.enum(PROGRAMME_ITEM_KINDS),
    parentItemId: z.string().nullable(),
    title: z.string(),
    activityKind: z.enum(ACTIVITY_KINDS).nullable(),
    kindLabel: z.string().nullable(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    groupIds: z.array(z.uuid()),
    locationId: z.uuid().nullable(),
    locationText: z.string().nullable(),
    dutyTypeId: z.uuid().nullable(),
    needed: z.number().int().nullable(),
  })
  .openapi("ProgrammePreviewItem");

export const ProgrammePreviewSchema = z
  .object({
    title: z.string(),
    edition: z.string().nullable(),
    firstDay: z.iso.date(),
    lastDay: z.iso.date(),
    timeZone: z.string(),
    items: z.array(ProgrammePreviewItemSchema),
    /** The template's slots and the groups each is mapped to. */
    slots: z.array(z.object({ key: z.string(), label: z.string(), groupIds: z.array(z.uuid()) })),
    event: z.object({ title: z.string(), audience: z.enum(EVENT_AUDIENCES) }).nullable(),
    warnings: z.array(ProgrammeNoticeSchema),
    refusals: z.array(ProgrammeNoticeSchema),
  })
  .openapi("ProgrammePreview");
export type ProgrammePreview = z.infer<typeof ProgrammePreviewSchema>;

/** Copying a programme to a new date (ADR 0054 decision 9): slots are its groups by ID. */
export const CopyProgrammeSchema = ApplyProgrammeSchema.omit({ edition: true })
  .extend({ preview: z.boolean().default(false) })
  .strict()
  .openapi("CopyProgrammeRequest");
export type CopyProgrammeInput = z.input<typeof CopyProgrammeSchema>;

// --- Programmes -------------------------------------------------------------------

export const ProgrammeSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    edition: z.string().nullable(),
    templateId: z.uuid().nullable(),
    eventId: z.uuid().nullable(),
    firstDay: z.iso.date(),
    lastDay: z.iso.date(),
    groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
  })
  .openapi("ProgrammeSummary");
export type ProgrammeSummary = z.infer<typeof ProgrammeSummarySchema>;

export const ProgrammeCreatedSchema = z
  .object({
    programme: ProgrammeSummarySchema,
    activities: z.number().int(),
    dutyShifts: z.number().int(),
  })
  .openapi("ProgrammeCreated");

export const ProgrammeListSchema = z
  .object({ items: z.array(ProgrammeSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("ProgrammeList");

export const ProgrammeListQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** From this day (default: all). */
  from: z.iso.date().optional(),
});

export const ProgrammePlaceSchema = z
  .object({
    /** Null: items without a place, or with a written place. */
    locationId: z.uuid().nullable(),
    name: z.string().nullable(),
  })
  .openapi("ProgrammePlace");

export const ProgrammeDetailSchema = ProgrammeSummarySchema.extend({
  timeZone: z.string(),
  /** The local days from the first to the last. */
  days: z.array(z.iso.date()),
  places: z.array(ProgrammePlaceSchema),
  /** The caller organises it (sees everything, conflicts marked; may copy, save, remove). */
  canManage: z.boolean(),
  /** Nothing is answered, registered, assigned or offered yet: it may be removed. */
  untouched: z.boolean(),
}).openapi("ProgrammeDetail");
export type ProgrammeDetail = z.infer<typeof ProgrammeDetailSchema>;

export const TimelineShiftSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    activityId: z.uuid().nullable(),
    locationId: z.uuid().nullable(),
    needed: z.number().int(),
    filled: z.number().int(),
    /** The caller or one of their family has it. */
    mine: z.boolean(),
  })
  .openapi("ProgrammeTimelineShift");

export const TimelineActivitySchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(ACTIVITY_KINDS),
    kindLabel: z.string().nullable(),
    title: z.string(),
    status: z.string(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    locationId: z.uuid().nullable(),
    locationText: z.string().nullable(),
    groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
    /** Organisers: another scheduled activity at the same place overlaps it. */
    conflict: z.boolean(),
  })
  .openapi("ProgrammeTimelineActivity");

export const ProgrammeTimelineQuerySchema = z.object({ day: z.iso.date() });

export const ProgrammeTimelineSchema = z
  .object({
    day: z.iso.date(),
    activities: z.array(TimelineActivitySchema),
    shifts: z.array(TimelineShiftSchema),
  })
  .openapi("ProgrammeTimeline");
export type ProgrammeTimeline = z.infer<typeof ProgrammeTimelineSchema>;

export const MyProgrammesSchema = z
  .object({
    items: z.array(ProgrammeSummarySchema.extend({ clubId: z.uuid() })),
  })
  .openapi("MyProgrammes");
export type MyProgrammes = z.infer<typeof MyProgrammesSchema>;
