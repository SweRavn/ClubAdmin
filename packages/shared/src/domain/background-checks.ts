// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8, ADR 0051 decision 6, ADR 0047 rule 6 amended):
// the categories a requirement is stated for, the club's stricter
// requirements, records of a certificate someone in the club saw (never the
// document, a code or a negative outcome), the club's overview, a request
// (Norway: the club's confirmation of purpose) and one's own status. People
// appear only as PersonSummary from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { DUTY_CHILD_CONTACTS } from "./duties.ts";

/** The duty categories requirements are stated for (the plugin contract's). */
export const BACKGROUND_CHECK_CATEGORIES = [
  "regular_contact_with_children",
  "alone_with_children",
  "overnight",
  "board",
] as const;
export type BackgroundCheckCategory = (typeof BACKGROUND_CHECK_CATEGORIES)[number];
export const BackgroundCheckCategorySchema = z.enum(BACKGROUND_CHECK_CATEGORIES);

/** A duty type's category from its contact with children (P2.6); `none`: no check. */
export const DUTY_CONTACT_CATEGORY: Record<
  (typeof DUTY_CHILD_CONTACTS)[number],
  BackgroundCheckCategory | null
> = {
  none: null,
  with_children: "regular_contact_with_children",
  alone_with_children: "alone_with_children",
};

/**
 * How strict a category is, for "a club may map a type to a stricter
 * category, never a weaker one": board < regular contact < overnight < alone.
 */
export const CATEGORY_STRICTNESS: Record<BackgroundCheckCategory, number> = {
  board: 0,
  regular_contact_with_children: 1,
  overnight: 2,
  alone_with_children: 3,
};

/** How the club saw a certificate. */
export const BACKGROUND_CHECK_SEEN = ["viewed", "digital_mailbox"] as const;

const pluginId = z.string().regex(/^[a-z][a-z0-9._-]{2,63}$/);
const checkType = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const day = z.iso.date();

export const BackgroundCheckRecordSchema = z
  .object({
    id: z.uuid(),
    pluginId,
    checkType,
    /** The check type's name in the viewer's language. */
    checkTypeName: z.string(),
    issuingCountry: z.string(),
    issuedOn: day,
    verifiedOn: day,
    /** Who ticked it off (null: not shown to the viewer, or gone). */
    verifiedBy: PersonSummarySchema.nullable(),
    method: z.string(),
    /** When a new check is needed: the plugin's or the club's interval (null: never). */
    expiresOn: day.nullable(),
    /** Why it no longer counts (`expired`, `superseded`, `closed`), never why a check failed. */
    closedReason: z.enum(["expired", "superseded", "closed"]).nullable(),
  })
  .openapi("BackgroundCheckRecord");
export type BackgroundCheckRecord = z.infer<typeof BackgroundCheckRecordSchema>;

export const BACKGROUND_CHECK_STATUSES = ["missing", "expiring", "valid", "to_delete"] as const;
export type BackgroundCheckStatus = (typeof BACKGROUND_CHECK_STATUSES)[number];

export const BackgroundCheckOverviewQuerySchema = z.object({
  status: z.enum(BACKGROUND_CHECK_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type BackgroundCheckOverviewQuery = z.infer<typeof BackgroundCheckOverviewQuerySchema>;

export const BackgroundCheckOverviewSchema = z
  .object({
    /** False when the club turned the plugin of its country off: nothing is required. */
    active: z.boolean(),
    /** Days before the expiry a check counts as expiring. */
    expiringDays: z.number().int(),
    items: z.array(
      z.object({
        person: PersonSummarySchema,
        /**
         * `missing`: a needed check is missing or expired; `expiring`: valid,
         * but needed again soon; `valid`; `to_delete`: records of someone who
         * no longer holds a role that needs them.
         */
        status: z.enum(BACKGROUND_CHECK_STATUSES),
        /** The categories the person's roles need (those the club requires). */
        categories: z.array(BackgroundCheckCategorySchema),
        /** The earliest expiry of the checks that count (null: none, or never). */
        expiresOn: day.nullable(),
        records: z.array(BackgroundCheckRecordSchema),
        /** An open request (Norway: the confirmation of purpose), if any. */
        request: z
          .object({ id: z.uuid(), status: z.string(), createdAt: z.iso.datetime() })
          .nullable(),
      }),
    ),
    /** People the viewer may not see (protected identity), left out above. */
    hiddenCount: z.number().int(),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("BackgroundCheckOverview");
export type BackgroundCheckOverview = z.infer<typeof BackgroundCheckOverviewSchema>;

export const BackgroundCheckClubRequirementSchema = z
  .object({
    pluginId,
    category: BackgroundCheckCategorySchema,
    checkType,
    /** Shorter than the plugin's interval, or set where it has none (null: the plugin's). */
    recheckMonths: z.number().int().min(1).max(120).nullable(),
  })
  .openapi("BackgroundCheckClubRequirement");
export type BackgroundCheckClubRequirement = z.infer<typeof BackgroundCheckClubRequirementSchema>;

export const BackgroundCheckRequirementsSchema = z
  .object({
    /** The background-check plugin of the club's country, and whether the club has it on. */
    plugin: z.object({ id: pluginId, enabled: z.boolean() }).nullable(),
    types: z.array(
      z.object({
        pluginId,
        key: checkType,
        name: z.string(),
        initiator: z.enum(["person", "club", "federation"]),
        maxAgeDaysWhenPresented: z.number().int().nullable(),
        recheckMonths: z.number().int().nullable(),
        minAge: z.number().int().nullable(),
      }),
    ),
    /** What the plugin requires or recommends per category, with the rule's name. */
    pluginRequirements: z.array(
      z.object({
        pluginId,
        category: BackgroundCheckCategorySchema,
        checkType,
        level: z.enum(["required", "recommended"]),
        basis: z.string(),
      }),
    ),
    /** The club's stricter additions. */
    clubRequirements: z.array(BackgroundCheckClubRequirementSchema),
    /** The club's roles and the category each needs (set in the role editor). */
    roles: z.array(
      z.object({
        id: z.uuid(),
        scope: z.enum(["club", "group"]),
        name: z.string(),
        templateKey: z.string().nullable(),
        category: BackgroundCheckCategorySchema.nullable(),
      }),
    ),
    /** Duty types: the category from the contact with children, and the club's stricter mapping. */
    dutyTypes: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        childContact: z.enum(DUTY_CHILD_CONTACTS),
        category: BackgroundCheckCategorySchema.nullable(),
        effectiveCategory: BackgroundCheckCategorySchema.nullable(),
      }),
    ),
  })
  .openapi("BackgroundCheckRequirements");
export type BackgroundCheckRequirements = z.infer<typeof BackgroundCheckRequirementsSchema>;

export const PutBackgroundCheckRequirementsSchema = z
  .object({
    clubRequirements: z.array(BackgroundCheckClubRequirementSchema).max(40),
    /** A duty type's stricter category (null: from its contact with children). */
    dutyTypes: z
      .array(z.object({ id: z.uuid(), category: BackgroundCheckCategorySchema.nullable() }))
      .max(200)
      .default([]),
  })
  .openapi("PutBackgroundCheckRequirements");
export type PutBackgroundCheckRequirementsInput = z.input<
  typeof PutBackgroundCheckRequirementsSchema
>;

/** Ticking off a certificate a person shows: nothing is uploaded, no code is kept. */
export const CreateBackgroundCheckRecordSchema = z
  .object({
    personId: z.uuid(),
    pluginId,
    checkType,
    issuedOn: day,
    method: z.enum(BACKGROUND_CHECK_SEEN).default("viewed"),
  })
  .strict()
  .openapi("CreateBackgroundCheckRecord");
export type CreateBackgroundCheckRecordInput = z.input<typeof CreateBackgroundCheckRecordSchema>;

export const BackgroundCheckRecordCreatedSchema = z
  .object({ id: z.uuid(), expiresOn: day.nullable() })
  .openapi("BackgroundCheckRecordCreated");

export const CreateBackgroundCheckRequestSchema = z
  .object({ personId: z.uuid(), pluginId, checkType })
  .strict()
  .openapi("CreateBackgroundCheckRequest");
export type CreateBackgroundCheckRequestInput = z.infer<typeof CreateBackgroundCheckRequestSchema>;

export const BackgroundCheckRequestCreatedSchema = z
  .object({ id: z.uuid(), status: z.string() })
  .openapi("BackgroundCheckRequestCreated");

export const BackgroundCheckRecordParamsSchema = z.object({
  clubId: z.uuid(),
  recordId: z.uuid(),
});

export const MyBackgroundChecksQuerySchema = z.object({ clubId: z.uuid() });

export const MyBackgroundChecksSchema = z
  .object({
    clubId: z.uuid(),
    active: z.boolean(),
    status: z.enum(["not_required", "missing", "expiring", "valid"]),
    /** What is required of me and why (role names and duty types). */
    required: z.array(
      z.object({
        category: BackgroundCheckCategorySchema,
        checkTypeName: z.string(),
        /** The plugin's rule (or the club's decision). */
        basis: z.string(),
        because: z.array(z.string()),
      }),
    ),
    expiresOn: day.nullable(),
    records: z.array(BackgroundCheckRecordSchema),
    /** How to get a check, per type: who starts it and how old it may be when shown. */
    howTo: z.array(
      z.object({
        name: z.string(),
        initiator: z.enum(["person", "club", "federation"]),
        maxAgeDaysWhenPresented: z.number().int().nullable(),
        minAge: z.number().int().nullable(),
      }),
    ),
  })
  .openapi("MyBackgroundChecks");
export type MyBackgroundChecks = z.infer<typeof MyBackgroundChecksSchema>;
