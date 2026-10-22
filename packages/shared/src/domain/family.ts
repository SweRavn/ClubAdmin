// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3): adding children, co-guardians, relatives and contact
// persons with chosen rights, duplicates and merges, own logins and the
// adult decision. People appear only as PersonSummary (PersonPresenter,
// ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  ADULT_DECISIONS,
  FULL_GUARDIANSHIP_KINDS,
  GENDERS,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  GUARDIANSHIP_STATUSES,
  LINKED_GUARDIANSHIP_KINDS,
} from "./core.ts";
import { EmailSchema, PersonalIdentityNumberInputSchema, PhoneSchema } from "./schemas.ts";

const name = z.string().trim().min(1).max(100);
const rights = z.array(z.enum(GUARDIANSHIP_RIGHTS)).max(GUARDIANSHIP_RIGHTS.length);
const clubRef = z.object({ id: z.uuid(), name: z.string() });

export const GuardianshipParamsSchema = z.object({ guardianshipId: z.uuid() });
export const GuardianInvitationParamsSchema = z.object({ invitationId: z.uuid() });
export const MergeParamsSchema = z.object({ mergeId: z.uuid() });
export const ClubGuardianshipParamsSchema = z.object({
  clubId: z.uuid(),
  guardianshipId: z.uuid(),
});

// --- Inputs ------------------------------------------------------------------

/** "Add child": no email; the caller becomes parent (or legal guardian). */
export const AddChildSchema = z
  .object({
    givenName: name,
    familyName: name,
    birthDate: z.iso.date(),
    gender: z.enum(GENDERS).nullish(),
    personalIdentityNumber: PersonalIdentityNumberInputSchema.nullish(),
    kind: z.enum(FULL_GUARDIANSHIP_KINDS).default("parent"),
  })
  .strict();
export type AddChildInput = z.input<typeof AddChildSchema>;

/** A person without login, reachable by phone (relatives, contact persons, paper forms). */
export const NewLinkedPersonSchema = z
  .object({ givenName: name, familyName: name, phone: PhoneSchema.nullish() })
  .strict();

/** Invite a co-guardian, relative or contact person by email; rights only for the latter two. */
export const CreateGuardianInvitationSchema = z
  .object({
    email: EmailSchema,
    kind: z.enum(GUARDIANSHIP_KINDS),
    rights: rights.optional(),
  })
  .strict();
export type CreateGuardianInvitationInput = z.input<typeof CreateGuardianInvitationSchema>;

/** Link a relative or contact person without login (name and phone). */
export const AddLinkedPersonSchema = z
  .object({
    person: NewLinkedPersonSchema,
    kind: z.enum(LINKED_GUARDIANSHIP_KINDS),
    rights: rights.optional(),
  })
  .strict();
export type AddLinkedPersonInput = z.input<typeof AddLinkedPersonSchema>;

/** An adult (or a young person from the consent age) links someone to themselves. */
export const CreateTrustedPersonSchema = z.union([
  z
    .object({
      email: EmailSchema,
      kind: z.enum(LINKED_GUARDIANSHIP_KINDS),
      rights: rights.optional(),
    })
    .strict(),
  AddLinkedPersonSchema,
]);
export type CreateTrustedPersonInput = z.input<typeof CreateTrustedPersonSchema>;

export const UpdateGuardianshipSchema = z.object({ rights }).strict();
export type UpdateGuardianshipInput = z.input<typeof UpdateGuardianshipSchema>;

export const AcceptGuardianInvitationSchema = z
  .object({ token: z.string().min(20).max(200) })
  .strict();
export const GuardianInvitationLookupQuerySchema = z.object({
  token: z.string().min(20).max(200),
});

export const MergePeopleSchema = z.object({ duplicatePersonId: z.uuid() }).strict();
export type MergePeopleInput = z.input<typeof MergePeopleSchema>;

export const OwnLoginInvitationSchema = z.object({ email: EmailSchema }).strict();

export const AdultDecisionSchema = z.object({ decision: z.enum(["keep", "end"]) }).strict();
export type AdultDecisionInput = z.input<typeof AdultDecisionSchema>;

/** A club records a guardianship from a paper application or form. */
export const ClubAddGuardianSchema = z
  .object({
    /** An existing person (from the register), or a new person without login. */
    guardian: z.union([
      z.object({ personId: z.uuid() }).strict(),
      z.object({ person: NewLinkedPersonSchema }).strict(),
    ]),
    kind: z.enum(GUARDIANSHIP_KINDS),
    /** Relatives and contact persons only. */
    rights: rights.optional(),
    /** That written consent exists (relatives and contact persons); never shown outside the family and the club's administrators. */
    consentNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ClubAddGuardianInput = z.input<typeof ClubAddGuardianSchema>;

/** Ending a full guardian's guardianship as a club manager needs a reason. */
export const ClubEndGuardianshipSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();
export type ClubEndGuardianshipInput = z.input<typeof ClubEndGuardianshipSchema>;

// --- Responses ---------------------------------------------------------------

export const GuardianEntrySchema = z
  .object({
    guardianshipId: z.uuid(),
    person: PersonSummarySchema,
    kind: z.enum(GUARDIANSHIP_KINDS),
    rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)),
    status: z.enum(GUARDIANSHIP_STATUSES),
    since: z.iso.datetime(),
    /** For full guardians, the ward and the club's administrators only. */
    phone: z.string().nullable().optional(),
    /** Recorded by a club from a paper form. */
    recordedByClub: z.boolean(),
    /** Full guardians, the ward and the club's administrators only. */
    consentNote: z.string().nullable().optional(),
    /** The caller. */
    isYou: z.boolean(),
    /** Whether the caller may end this link or change its rights. */
    canEnd: z.boolean(),
    canChangeRights: z.boolean(),
  })
  .openapi("GuardianEntry");
export type GuardianEntry = z.infer<typeof GuardianEntrySchema>;

export const PendingGuardianInvitationSchema = z
  .object({
    invitationId: z.uuid(),
    kind: z.enum(GUARDIANSHIP_KINDS),
    rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)),
    /** Full guardians (and the inviter) only. */
    email: z.string().optional(),
    expiresAt: z.iso.datetime(),
    resentAt: z.iso.datetime().nullable(),
    /** The caller may resend or revoke it. */
    canManage: z.boolean(),
  })
  .openapi("PendingGuardianInvitation");

export const WardGuardiansSchema = z
  .object({
    ward: PersonSummarySchema,
    guardians: z.array(GuardianEntrySchema),
    /** Relatives see the guardians' names only, never invitations. */
    invitations: z.array(PendingGuardianInvitationSchema),
  })
  .openapi("WardGuardians");
export type WardGuardians = z.infer<typeof WardGuardiansSchema>;

export const ChildAddedSchema = z
  .object({ person: PersonSummarySchema, guardianshipId: z.uuid() })
  .openapi("ChildAdded");
export type ChildAdded = z.infer<typeof ChildAddedSchema>;

export const GuardianInvitationCreatedSchema = z
  .object({ invitationId: z.uuid(), expiresAt: z.iso.datetime() })
  .openapi("GuardianInvitationCreated");
export type GuardianInvitationCreated = z.infer<typeof GuardianInvitationCreatedSchema>;

export const GuardianshipCreatedSchema = z
  .object({ guardianshipId: z.uuid(), person: PersonSummarySchema })
  .openapi("GuardianshipCreated");
export type GuardianshipCreated = z.infer<typeof GuardianshipCreatedSchema>;

export const TrustedPersonCreatedSchema = z
  .object({
    invitation: GuardianInvitationCreatedSchema.nullable(),
    guardianship: GuardianshipCreatedSchema.nullable(),
  })
  .openapi("TrustedPersonCreated");
export type TrustedPersonCreated = z.infer<typeof TrustedPersonCreatedSchema>;

export const GuardianshipResultSchema = z
  .object({
    guardianshipId: z.uuid(),
    kind: z.enum(GUARDIANSHIP_KINDS),
    rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)),
    status: z.enum(GUARDIANSHIP_STATUSES),
  })
  .openapi("GuardianshipResult");
export type GuardianshipResult = z.infer<typeof GuardianshipResultSchema>;

/** The landing page of an invitation link: nothing if it is not valid (any reason). */
export const GuardianInvitationLookupSchema = z
  .object({
    kind: z.enum(GUARDIANSHIP_KINDS),
    rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)),
    /** Null when the ward or the inviter is protected ("a guardian"). */
    wardGivenName: z.string().nullable(),
    inviterName: z.string().nullable(),
    expiresAt: z.iso.datetime(),
  })
  .openapi("GuardianInvitationLookup");
export type GuardianInvitationLookup = z.infer<typeof GuardianInvitationLookupSchema>;

export const GuardianInvitationAcceptedSchema = z
  .object({
    guardianshipId: z.uuid(),
    ward: PersonSummarySchema,
    kind: z.enum(GUARDIANSHIP_KINDS),
    /** The ward has protected identity: suggest protecting oneself too. */
    suggestProtection: z.boolean(),
  })
  .openapi("GuardianInvitationAccepted");
export type GuardianInvitationAccepted = z.infer<typeof GuardianInvitationAcceptedSchema>;

export const TrustedPeopleSchema = z
  .object({
    /** Whether the caller may link people to themselves (adult, or from the consent age). */
    canLink: z.boolean(),
    people: z.array(GuardianEntrySchema),
    invitations: z.array(PendingGuardianInvitationSchema),
  })
  .openapi("TrustedPeople");
export type TrustedPeople = z.infer<typeof TrustedPeopleSchema>;

const DuplicateSideSchema = z.object({
  person: PersonSummarySchema,
  birthDate: z.iso.date().nullable(),
  clubs: z.array(clubRef),
  guardians: z.array(PersonSummarySchema),
});

export const DUPLICATE_REASONS = ["name_and_birth_date", "personal_identity_number"] as const;

export const FamilyDuplicatesSchema = z
  .object({
    pairs: z.array(
      z.object({
        person: DuplicateSideSchema,
        duplicate: DuplicateSideSchema,
        reason: z.enum(DUPLICATE_REASONS),
        /** The caller is a full guardian of both (otherwise a guardian of both merges). */
        canMerge: z.boolean(),
      }),
    ),
    /** The caller's merges that can still be undone. */
    merges: z.array(
      z.object({ mergeId: z.uuid(), kept: PersonSummarySchema, undoUntil: z.iso.datetime() }),
    ),
  })
  .openapi("FamilyDuplicates");
export type FamilyDuplicates = z.infer<typeof FamilyDuplicatesSchema>;

export const ClubDuplicatesSchema = z
  .object({
    items: z.array(
      z.object({
        person: PersonSummarySchema,
        duplicate: PersonSummarySchema,
        birthDate: z.iso.date().nullable(),
        reason: z.enum(DUPLICATE_REASONS),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi("ClubDuplicates");
export type ClubDuplicates = z.infer<typeof ClubDuplicatesSchema>;
export const ClubDuplicatesQuerySchema = z.object({
  /** `nextCursor` of the previous page: "personId:duplicateId". */
  cursor: z
    .string()
    .regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ClubDuplicatesQuery = z.infer<typeof ClubDuplicatesQuerySchema>;

export const MergeResultSchema = z
  .object({ mergeId: z.uuid(), keptPersonId: z.uuid(), undoUntil: z.iso.datetime() })
  .openapi("MergeResult");
export type MergeResult = z.infer<typeof MergeResultSchema>;

export const OwnLoginInvitationCreatedSchema = z
  .object({ invitationId: z.uuid(), expiresAt: z.iso.datetime() })
  .openapi("OwnLoginInvitationCreated");

export const AdultGuardiansSchema = z
  .object({
    guardians: z.array(
      z.object({
        guardianshipId: z.uuid(),
        person: PersonSummarySchema,
        kind: z.enum(GUARDIANSHIP_KINDS),
        flaggedAt: z.iso.datetime(),
        decision: z.enum(ADULT_DECISIONS).nullable(),
      }),
    ),
  })
  .openapi("AdultGuardians");
export type AdultGuardians = z.infer<typeof AdultGuardiansSchema>;

export const ClubGuardiansSchema = z
  .object({ ward: PersonSummarySchema, guardians: z.array(GuardianEntrySchema) })
  .openapi("ClubGuardians");
export type ClubGuardians = z.infer<typeof ClubGuardiansSchema>;

// --- Form input --------------------------------------------------------------

/** Field names of the web forms that create people (the same as the schema's). */
export type PersonFormField = "givenName" | "familyName" | "phone" | "birthDate";

/**
 * A new person without login from form fields (web forms post plain fields;
 * the API validates with NewLinkedPersonSchema). Empty phone means none.
 */
export function linkedPersonInput(field: (name: PersonFormField) => string) {
  const phone = field("phone");
  return {
    givenName: field("givenName"),
    familyName: field("familyName"),
    ...(phone ? { phone } : {}),
  };
}

/** "Add child" from form fields (validated by AddChildSchema in the API). */
export function addChildInput(
  field: (name: PersonFormField) => string,
  extra: Pick<AddChildInput, "kind" | "personalIdentityNumber">,
): AddChildInput {
  return {
    givenName: field("givenName"),
    familyName: field("familyName"),
    birthDate: field("birthDate"),
    ...extra,
  };
}
