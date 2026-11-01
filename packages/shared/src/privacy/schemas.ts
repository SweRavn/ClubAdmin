// SPDX-License-Identifier: AGPL-3.0-only
// Requests and responses of the privacy endpoints (P1.8a): consents, the
// club's privacy settings, board decisions and policy, leaving a club and
// stepping down from assignments. People only as PersonSummary (presenter).

import { PersonSummarySchema } from "../auth/schemas.ts";
import {
  CLUB_ROLES,
  CONSENT_PURPOSES,
  CONSENT_REVOKED_REASONS,
  CONSENT_SOURCES,
  DECISION_BODIES,
  GROUP_FUNCTIONS,
} from "../domain/core.ts";
import { z } from "../zod.ts";

const day = z.iso.date();
const textVersion = z.string().regex(/^(default|club):[1-9][0-9]*$/);

export const ConsentPurposeParamsSchema = z.object({
  personId: z.uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
});
export const ClubQuerySchema = z.object({ clubId: z.uuid() });

/** The text of a consent as the reader sees it (rendered in their language). */
export const ConsentTextSchema = z
  .object({
    textVersion,
    body: z.string(),
    publishedAt: z.iso.datetime().nullable(),
  })
  .openapi("ConsentText");
export type ConsentText = z.infer<typeof ConsentTextSchema>;

export const OpenConsentSchema = z
  .object({
    textVersion,
    /** Whether it was given for the club's current text. */
    current: z.boolean(),
    source: z.enum(CONSENT_SOURCES),
    givenAt: z.iso.datetime(),
    /** Who gave it; null when the viewer may not see them (or they were erased). */
    givenBy: PersonSummarySchema.nullable(),
  })
  .openapi("OpenConsent");

export const ConsentStatusSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    /** False for a protected person's photo, video, streaming and contact purposes. */
    applicable: z.boolean(),
    consent: OpenConsentSchema.nullable(),
    mayGive: z.boolean(),
    mayWithdraw: z.boolean(),
  })
  .openapi("ConsentStatus");
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

/** GET /me/consents: per club and person (me and the wards I decide for). */
export const MyConsentsSchema = z
  .object({
    clubs: z.array(
      z.object({
        clubId: z.uuid(),
        clubName: z.string(),
        texts: z.array(ConsentTextSchema.extend({ purpose: z.enum(CONSENT_PURPOSES) })),
        people: z.array(
          z.object({ person: PersonSummarySchema, purposes: z.array(ConsentStatusSchema) }),
        ),
      }),
    ),
  })
  .openapi("MyConsents");
export type MyConsents = z.infer<typeof MyConsentsSchema>;

export const ConsentHistoryEntrySchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    textVersion,
    source: z.enum(CONSENT_SOURCES),
    givenAt: z.iso.datetime(),
    givenBy: PersonSummarySchema.nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revokedReason: z.enum(CONSENT_REVOKED_REASONS).nullable(),
    /** The club's note on a recorded paper consent (registrars and managers only). */
    clubNote: z.string().nullable().optional(),
  })
  .openapi("ConsentHistoryEntry");

/** GET /people/{personId}/consents?clubId=: status for leaders, history for the family and administrators. */
export const PersonConsentsSchema = z
  .object({
    personId: z.uuid(),
    clubId: z.uuid(),
    purposes: z.array(ConsentStatusSchema),
    history: z.array(ConsentHistoryEntrySchema).optional(),
    /** Registrars and managers may record a paper consent. */
    mayRecord: z.boolean(),
  })
  .openapi("PersonConsents");
export type PersonConsents = z.infer<typeof PersonConsentsSchema>;

export const GiveConsentSchema = z
  .object({
    textVersion,
    /** Registrars and managers recording a paper form ("paper form 2026-08-14"). */
    clubNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .openapi("GiveConsent");
export type GiveConsentInput = z.infer<typeof GiveConsentSchema>;

export const GroupConsentsQuerySchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type GroupConsentsQuery = z.infer<typeof GroupConsentsQuerySchema>;

export const GroupConsentsSchema = z
  .object({
    purposes: z.array(z.enum(CONSENT_PURPOSES)),
    /** Every current member is counted, also those the viewer may not see. */
    counts: z.array(
      z.object({
        purpose: z.enum(CONSENT_PURPOSES),
        consented: z.number().int(),
        notApplicable: z.number().int(),
        total: z.number().int(),
      }),
    ),
    items: z.array(
      z.object({
        person: PersonSummarySchema,
        consents: z.array(
          z.object({
            purpose: z.enum(CONSENT_PURPOSES),
            status: z.enum(["given", "missing", "not_applicable"]),
          }),
        ),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("GroupConsents");
export type GroupConsents = z.infer<typeof GroupConsentsSchema>;

export const SettingDecisionSchema = z
  .object({
    id: z.uuid(),
    body: z.enum(DECISION_BODIES),
    decidedOn: day,
    reference: z.string(),
    effectiveFrom: day,
    settings: z.record(z.string(), z.unknown()),
    applied: z.boolean(),
    recordedAt: z.iso.datetime(),
    recordedBy: PersonSummarySchema.nullable(),
  })
  .openapi("SettingDecision");
export type SettingDecision = z.infer<typeof SettingDecisionSchema>;

export const SettingDecisionRefSchema = SettingDecisionSchema.pick({
  id: true,
  body: true,
  decidedOn: true,
  reference: true,
  effectiveFrom: true,
}).openapi("SettingDecisionRef");

export const RecordDecisionSchema = z
  .object({
    body: z.enum(DECISION_BODIES),
    decidedOn: day,
    reference: z.string().trim().min(1).max(200),
    effectiveFrom: day.optional(),
    settings: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("RecordDecision");
export type RecordDecisionInput = z.infer<typeof RecordDecisionSchema>;

export const DecisionsPageSchema = z
  .object({ items: z.array(SettingDecisionSchema), nextCursor: z.uuid().nullable() })
  .openapi("SettingDecisions");

export const ClubPrivacySchema = z
  .object({
    clubId: z.uuid(),
    privacyContactEmail: z.string().nullable(),
    consentPurposes: z.array(z.enum(CONSENT_PURPOSES)),
    texts: z.array(ConsentTextSchema.extend({ purpose: z.enum(CONSENT_PURPOSES) })),
    settings: z.array(
      z.object({
        key: z.string(),
        value: z.unknown(),
        default: z.unknown(),
        decidedBy: z.enum(["board", "manager"]),
        min: z.number().int().optional(),
        max: z.number().int().optional(),
        unit: z.enum(["days", "months"]).optional(),
        /** The decision the value rests on; null: the default, not yet decided. */
        decision: SettingDecisionRefSchema.nullable(),
      }),
    ),
    retention: z.array(
      z.object({
        key: z.string(),
        period: z.union([
          z.object({ value: z.number(), unit: z.enum(["hours", "days", "months", "years"]) }),
          z.literal("until_erased"),
        ]),
        setting: z.string().nullable(),
        installationSetting: z.string().nullable(),
        status: z.enum(["implemented", "planned"]),
      }),
    ),
    /** Pending decisions (effective later). */
    pending: z.array(SettingDecisionRefSchema),
  })
  .openapi("ClubPrivacy");
export type ClubPrivacy = z.infer<typeof ClubPrivacySchema>;

export const PrivacyPolicyQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});

export const PrivacyPolicySchema = z
  .object({
    clubId: z.uuid(),
    version: z.number().int(),
    effectiveFrom: day,
    templateVersion: z.number().int(),
    sections: z.array(z.object({ key: z.string(), title: z.string(), body: z.string() })),
    /** Per setting shown: the decision it rests on (null: default). */
    decisions: z.array(
      z.object({ key: z.string(), decision: SettingDecisionRefSchema.nullable() }),
    ),
    versions: z.array(
      z.object({
        version: z.number().int(),
        effectiveFrom: day,
        decision: SettingDecisionRefSchema.nullable(),
      }),
    ),
  })
  .openapi("PrivacyPolicy");
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;

export const PublishConsentTextSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    texts: z
      .object({
        sv: z.string().trim().min(20).max(4000).optional(),
        en: z.string().trim().min(20).max(4000).optional(),
        nb: z.string().trim().min(20).max(4000).optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("PublishConsentText");
export type PublishConsentTextInput = z.infer<typeof PublishConsentTextSchema>;

export const ConsentTextsQuerySchema = z.object({ purpose: z.enum(CONSENT_PURPOSES) });
export const ConsentTextVersionsSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    current: textVersion,
    default: ConsentTextSchema,
    versions: z.array(
      z.object({
        textVersion,
        texts: z.record(z.string(), z.string()),
        publishedAt: z.iso.datetime(),
        publishedBy: PersonSummarySchema.nullable(),
      }),
    ),
  })
  .openapi("ConsentTextVersions");

/** An assignment the person holds in a club (P1.8a): leaving needs none. */
export const AssignmentSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["role", "group_function", "group_owner"]),
    role: z.enum(CLUB_ROLES).optional(),
    groupId: z.uuid().optional(),
    groupName: z.string().optional(),
    function: z.enum(GROUP_FUNCTIONS).optional(),
    /** Null when the person may step down; otherwise why not. */
    blockedBy: z.enum(["last_club_manager"]).nullable(),
  })
  .openapi("Assignment");
export type Assignment = z.infer<typeof AssignmentSchema>;

export const PersonInClubQuerySchema = z.object({ personId: z.uuid().optional() });
export const AssignmentParamsSchema = z.object({ clubId: z.uuid(), assignmentId: z.uuid() });

export const AssignmentsSchema = z
  .object({ personId: z.uuid(), clubId: z.uuid(), items: z.array(AssignmentSchema) })
  .openapi("Assignments");

export const LEAVE_BLOCKERS = [
  "roles_must_be_removed",
  "outstanding_invoices",
  "last_club_manager",
] as const;

export const LeavePreviewSchema = z
  .object({
    personId: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    /** Leaving is possible when there are no blockers. */
    blockers: z.array(
      z.object({
        code: z.enum(LEAVE_BLOCKERS),
        /** For roles_must_be_removed: the assignments to end first. */
        assignments: z.array(AssignmentSchema).optional(),
        /** For outstanding_invoices: how many, and whom to contact (a role, never a name). */
        count: z.number().int().optional(),
        contactRole: z.enum(CLUB_ROLES).optional(),
      }),
    ),
    /** What ends now. */
    ends: z.array(
      z.enum([
        "membership",
        "groups",
        "join_requests",
        "waiting_lists",
        "event_registrations",
        "consents",
      ]),
    ),
    /** What the club keeps, and for how long after leaving. */
    keeps: z.object({ formerMemberRetentionMonths: z.number().int() }),
  })
  .openapi("LeavePreview");
export type LeavePreview = z.infer<typeof LeavePreviewSchema>;

export const LeaveClubSchema = z
  .object({ personId: z.uuid(), removeNow: z.boolean().default(false) })
  .strict()
  .openapi("LeaveClub");
export type LeaveClubInput = z.input<typeof LeaveClubSchema>;
