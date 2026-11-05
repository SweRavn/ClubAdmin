// SPDX-License-Identifier: AGPL-3.0-only
// History panels, the club-wide changes and the audit log (P1.9, ADR 0042).
// Values come formatted as the history view policy says (enum keys, ISO
// dates, resolved references); people only as PersonSummary through the
// presenter, hidden people as { kind: "hidden_person" }.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { ActorReferenceSchema } from "../domain/responses.ts";
import { z } from "../zod.ts";
import { AUDIT_CATEGORIES, CLUB_HISTORY_RESOURCES, HISTORY_RESOURCES } from "./catalogue.ts";

/** Records a history entry links to or mentions, by kind. */
export const HISTORY_RECORD_KINDS = [
  "person",
  "group",
  "activity",
  "series",
  "event",
  "club",
  "location",
  "season",
] as const;
export type HistoryRecordKind = (typeof HISTORY_RECORD_KINDS)[number];

/** Page size of the history and audit lists. */
export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 100;
/** The longest period of a filtered club-wide view (ADR 0042: bounded work). */
export const HISTORY_FILTER_MAX_DAYS = 90;
/** The longest period of the audit log filter. */
export const AUDIT_RANGE_MAX_DAYS = 400;
/** Records in one panel's scope; above it the panel suggests the club-wide view. */
export const HISTORY_SCOPE_MAX = 2000;

export const HistoryRefSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), person: PersonSummarySchema }),
    z.object({ kind: z.literal("hidden_person") }),
    z.object({ kind: z.literal("erased_person") }),
    z.object({
      kind: z.literal("record"),
      type: z.enum(HISTORY_RECORD_KINDS),
      id: z.uuid(),
      /** Its name or title; null if it has none (an activity without a title) or is gone. */
      name: z.string().nullable(),
      /** When an activity or event starts (to name it without a title). */
      startsAt: z.iso.datetime({ offset: true }).optional(),
    }),
  ])
  .openapi("HistoryRef");
export type HistoryRef = z.infer<typeof HistoryRefSchema>;

const scalar = <T extends string, V extends z.ZodType>(type: T, value: V) =>
  z.object({ type: z.literal(type), value });

const HISTORY_SCALARS = [
  scalar("text", z.string()),
  scalar("number", z.number()),
  scalar("boolean", z.boolean()),
  scalar("date", z.string()),
  scalar("datetime", z.string()),
  /** An enum value: the label is the message `${enumKey}.${value}`. */
  z.object({ type: z.literal("enum"), enumKey: z.string(), value: z.string() }),
  z.object({ type: z.literal("ref"), ref: HistoryRefSchema }),
] as const;

/** One value (no lists). */
export const HistoryScalarSchema = z
  .discriminatedUnion("type", [...HISTORY_SCALARS])
  .openapi("HistoryScalar");
export type HistoryScalar = z.infer<typeof HistoryScalarSchema>;

/** A column's value as the policy formats it: a scalar or a list of scalars. */
export const HistoryValueSchema = z
  .discriminatedUnion("type", [
    ...HISTORY_SCALARS,
    z.object({ type: z.literal("list"), items: z.array(HistoryScalarSchema) }),
  ])
  .openapi("HistoryValue");
export type HistoryValue = z.infer<typeof HistoryValueSchema>;

export const HistoryChangeSchema = z
  .object({
    column: z.string(),
    /** The column's label (an existing form label where one exists). */
    labelKey: z.string(),
    /** value: old and new shown; erased: scrubbed on erasure; redacted: never stored. */
    kind: z.enum(["value", "erased", "redacted"]),
    old: HistoryValueSchema.nullable(),
    new: HistoryValueSchema.nullable(),
  })
  .openapi("HistoryChange");
export type HistoryChange = z.infer<typeof HistoryChangeSchema>;

export const HistoryItemSchema = z
  .object({
    id: z.uuid(),
    changedAt: z.iso.datetime({ offset: true }),
    operation: z.enum(["created", "updated", "deleted"]),
    /** The kind of record (`history.resources.<key>`). */
    resource: z.enum(HISTORY_RESOURCES),
    recordId: z.uuid(),
    /** The detail page the record belongs to, for links in the club-wide view. */
    link: z.object({ kind: z.enum(HISTORY_RECORD_KINDS), id: z.uuid() }).nullable(),
    /** Whom and what the record is about (the member, the group, …). */
    about: z.array(HistoryRefSchema),
    actor: ActorReferenceSchema,
    onBehalfOf: ActorReferenceSchema.nullable(),
    changes: z.array(HistoryChangeSchema),
    /** Columns changed that are not shown with values ("Other fields changed"). */
    otherFieldsChanged: z.boolean(),
    /** Rows of one action share it (the client groups them). */
    transactionId: z.string(),
  })
  .openapi("HistoryItem");
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryPageSchema = z
  .object({
    items: z.array(HistoryItemSchema),
    nextCursor: z.string().nullable(),
    /** How long history is kept (HISTORY_RETENTION_MONTHS). */
    retentionMonths: z.number().int(),
  })
  .openapi("HistoryPage");
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

const cursor = z.string().max(200).optional();
const limit = z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_DEFAULT);
const instant = z.iso.datetime({ offset: true }).optional();

/** A panel's page: the cursor is the opaque (time, ID) of the last item, not an ID. */
export const HistoryQuerySchema = z.object({ cursor, limit }).openapi("HistoryQuery");
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

export const PersonHistoryQuerySchema = z
  .object({ clubId: z.uuid(), cursor, limit })
  .openapi("PersonHistoryQuery");
export type PersonHistoryQuery = z.infer<typeof PersonHistoryQuerySchema>;

export const ClubHistoryQuerySchema = z
  .object({
    /** "club": the club page's own panel (the club, places, phone numbers, consent texts, decisions). */
    scope: z.enum(["club"]).optional(),
    table: z.enum(CLUB_HISTORY_RESOURCES).optional(),
    actorId: z.uuid().optional(),
    from: instant,
    to: instant,
    cursor,
    limit,
  })
  .openapi("ClubHistoryQuery");
export type ClubHistoryQuery = z.infer<typeof ClubHistoryQuerySchema>;

export const AuditEventsQuerySchema = z
  .object({
    category: z.enum(AUDIT_CATEGORIES).optional(),
    action: z.string().max(100).optional(),
    actorId: z.uuid().optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: z.uuid().optional(),
    from: instant,
    to: instant,
    cursor,
    limit,
  })
  .openapi("AuditEventsQuery");
export type AuditEventsQuery = z.infer<typeof AuditEventsQuerySchema>;

export const AuditItemSchema = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    action: z.string(),
    category: z.enum(AUDIT_CATEGORIES),
    resourceType: z.string(),
    resourceId: z.uuid().nullable(),
    /** The detail page of the resource, if it has one. */
    link: z.object({ kind: z.enum(HISTORY_RECORD_KINDS), id: z.uuid() }).nullable(),
    /** The resource named (a person through the presenter, a group's name, …). */
    about: HistoryRefSchema.nullable(),
    actor: ActorReferenceSchema,
    onBehalfOf: ActorReferenceSchema.nullable(),
    /** Field names (no values), with their label where the history policy has one. */
    changedFields: z.array(z.object({ name: z.string(), labelKey: z.string().nullable() })),
  })
  .openapi("AuditItem");
export type AuditItem = z.infer<typeof AuditItemSchema>;

export const AuditPageSchema = z
  .object({
    items: z.array(AuditItemSchema),
    nextCursor: z.string().nullable(),
    /** How long audit events are kept (AUDIT_RETENTION_MONTHS). */
    retentionMonths: z.number().int(),
  })
  .openapi("AuditPage");
export type AuditPage = z.infer<typeof AuditPageSchema>;
