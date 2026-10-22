// SPDX-License-Identifier: AGPL-3.0-only
// Sign-up, club creation, joining, invitations and club managers (P1.1,
// ADR 0018): request and response schemas. People appear only as
// PersonSummary (PersonPresenter, ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  CLUB_CREATION_REQUEST_STATUSES,
  CLUB_ROLES,
  HANDOVER_STATUSES,
  INVITATION_KINDS,
  JOIN_POLICIES,
  JOIN_REQUEST_STATUSES,
  MEMBERSHIP_TYPES,
} from "./core.ts";
import { ClubSchema } from "./responses.ts";
import { CreateClubSchema } from "./schemas.ts";

const name = z.string().trim().min(1).max(100);

/** Body of actions that return nothing else. */
export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");
const message = z.string().trim().min(1).max(1000);

// --- Profile ------------------------------------------------------------

/** Completing the profile after sign-up: the birth date is needed for age rules. */
export const CompleteProfileSchema = z
  .object({ givenName: name, familyName: name, birthDate: z.iso.date() })
  .strict()
  .openapi("CompleteProfileRequest");
export type CompleteProfileInput = z.infer<typeof CompleteProfileSchema>;

export const MyProfileSchema = z
  .object({
    person: PersonSummarySchema,
    birthDate: z.iso.date().nullable(),
    /** Name and birth date are known: the person may create clubs and join. */
    complete: z.boolean(),
  })
  .openapi("MyProfile");
export type MyProfile = z.infer<typeof MyProfileSchema>;

// --- Club search ---------------------------------------------------------

export const ClubSearchQuerySchema = z.object({
  /** Part of the name, the short name or the city. */
  q: z.string().trim().min(2).max(100).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ClubSearchQuery = z.infer<typeof ClubSearchQuerySchema>;

export const ClubListingSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    shortName: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string(),
    joinPolicy: z.enum(JOIN_POLICIES),
  })
  .openapi("ClubListing");
export type ClubListing = z.infer<typeof ClubListingSchema>;

export const ClubSearchResultSchema = z
  .object({ items: z.array(ClubListingSchema), nextCursor: z.uuid().nullable() })
  .openapi("ClubSearchResult");
export type ClubSearchResult = z.infer<typeof ClubSearchResultSchema>;

// --- Club creation -------------------------------------------------------

export const CreateClubRequestSchema = CreateClubSchema.openapi("CreateClubRequest");

export const ClubCreationRequestSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(CLUB_CREATION_REQUEST_STATUSES),
    name: z.string(),
    slug: z.string(),
    country: z.string(),
    createdAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    decisionMessage: z.string().nullable(),
    /** The club, once approved. */
    clubId: z.uuid().nullable(),
  })
  .openapi("ClubCreationRequest");
export type ClubCreationRequestResponse = z.infer<typeof ClubCreationRequestSchema>;

/** POST /clubs: the club (CLUB_CREATION=open, operators) or a request for an operator to decide. */
export const CreateClubResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("created"), club: ClubSchema }),
    z.object({ outcome: z.literal("requested"), request: ClubCreationRequestSchema }),
  ])
  .openapi("CreateClubResult");
export type CreateClubResult = z.infer<typeof CreateClubResultSchema>;

export const ClubCreationRequestListSchema = z
  .object({
    items: z.array(
      ClubCreationRequestSchema.extend({ requestedBy: PersonSummarySchema.nullable() }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("ClubCreationRequestList");
export type ClubCreationRequestList = z.infer<typeof ClubCreationRequestListSchema>;

export const MyClubCreationRequestsSchema = z
  .object({ items: z.array(ClubCreationRequestSchema) })
  .openapi("MyClubCreationRequests");

export const ClubCreationRequestQuerySchema = z.object({
  status: z.enum(CLUB_CREATION_REQUEST_STATUSES).default("pending"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const DecisionSchema = z
  .object({ decision: z.enum(["approve", "reject"]), message: message.optional() })
  .strict()
  .openapi("Decision");
export type DecisionInput = z.infer<typeof DecisionSchema>;

export const RequestParamsSchema = z.object({ requestId: z.uuid() });

// --- Join requests -------------------------------------------------------

export const CreateJoinRequestSchema = z
  .object({
    /** The caller and/or their wards (guardian with act_on_behalf). */
    personIds: z.array(z.uuid()).min(1).max(10),
    message: message.optional(),
    /** Groups the applicants would like to join: a hint for the club. */
    preferredGroupIds: z.array(z.uuid()).max(5).default([]),
  })
  .strict()
  .openapi("CreateJoinRequest");
export type CreateJoinRequestInput = z.input<typeof CreateJoinRequestSchema>;

export const JoinOutcomeSchema = z
  .object({
    items: z.array(
      z.object({
        personId: z.uuid(),
        /** member: joined at once (open club); pending: the club decides. */
        result: z.enum(["member", "pending"]),
        joinRequestId: z.uuid().nullable(),
      }),
    ),
  })
  .openapi("JoinOutcome");
export type JoinOutcome = z.infer<typeof JoinOutcomeSchema>;

const joinRequestFields = {
  id: z.uuid(),
  status: z.enum(JOIN_REQUEST_STATUSES),
  message: z.string().nullable(),
  preferredGroupIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  decisionMessage: z.string().nullable(),
};

export const MyJoinRequestsSchema = z
  .object({
    items: z.array(
      z.object({
        ...joinRequestFields,
        club: z.object({ id: z.uuid(), name: z.string() }),
        person: PersonSummarySchema,
      }),
    ),
  })
  .openapi("MyJoinRequests");
export type MyJoinRequests = z.infer<typeof MyJoinRequestsSchema>;

export const JoinRequestListSchema = z
  .object({
    items: z.array(
      z.object({
        ...joinRequestFields,
        person: PersonSummarySchema,
        /** Null when the applicant applied themselves, or the requester is hidden. */
        requestedBy: PersonSummarySchema.nullable(),
        preferredGroups: z.array(z.object({ id: z.uuid(), name: z.string() })),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("JoinRequestList");
export type JoinRequestList = z.infer<typeof JoinRequestListSchema>;

export const JoinRequestQuerySchema = z.object({
  status: z.enum(JOIN_REQUEST_STATUSES).default("pending"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const JoinRequestParamsSchema = z.object({ clubId: z.uuid(), joinRequestId: z.uuid() });
export const MyJoinRequestParamsSchema = z.object({ joinRequestId: z.uuid() });

export const JoinRequestDecisionSchema = DecisionSchema.extend({
  membershipType: z.enum(MEMBERSHIP_TYPES).optional(),
})
  .strict()
  .openapi("JoinRequestDecision");
export type JoinRequestDecisionInput = z.infer<typeof JoinRequestDecisionSchema>;

// --- Invitations ---------------------------------------------------------

/** 8 characters without look-alikes (no 0/O, 1/I/L). */
export const INVITATION_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const InvitationCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/));

const invitationPresets = {
  groupId: z.uuid().optional(),
  /** Only club managers may preset a role. */
  rolePreset: z.enum(CLUB_ROLES).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(14),
};

export const CreateInvitationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("email"),
        email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
        ...invitationPresets,
      })
      .strict(),
    z
      .object({
        kind: z.literal("link"),
        maxUses: z.number().int().min(1).max(1000).optional(),
        ...invitationPresets,
      })
      .strict(),
    z
      .object({
        kind: z.literal("code"),
        maxUses: z.number().int().min(1).max(1000).optional(),
        ...invitationPresets,
      })
      .strict(),
  ])
  .openapi("CreateInvitation");
export type CreateInvitationInput = z.input<typeof CreateInvitationSchema>;

export const INVITATION_STATES = ["active", "expired", "revoked", "used_up"] as const;

export const InvitationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(INVITATION_KINDS),
    state: z.enum(INVITATION_STATES),
    /** Email invitations: the address it was sent to. */
    email: z.string().nullable(),
    groupId: z.uuid().nullable(),
    rolePreset: z.enum(CLUB_ROLES).nullable(),
    expiresAt: z.iso.datetime(),
    maxUses: z.number().int().nullable(),
    uses: z.number().int(),
    createdAt: z.iso.datetime(),
    createdBy: PersonSummarySchema.nullable(),
  })
  .openapi("Invitation");
export type InvitationResponse = z.infer<typeof InvitationSchema>;

export const InvitationListSchema = z
  .object({ items: z.array(InvitationSchema), nextCursor: z.uuid().nullable() })
  .openapi("InvitationList");
export type InvitationList = z.infer<typeof InvitationListSchema>;

/** The secret is returned once, at creation (links and codes; email invitations are mailed). */
export const InvitationCreatedSchema = z
  .object({
    invitation: InvitationSchema,
    url: z.string().nullable(),
    code: z.string().nullable(),
  })
  .openapi("InvitationCreated");
export type InvitationCreated = z.infer<typeof InvitationCreatedSchema>;

export const InvitationParamsSchema = z.object({ clubId: z.uuid(), invitationId: z.uuid() });

const invitationSecret = {
  token: z.string().trim().min(20).max(100).optional(),
  code: InvitationCodeSchema.optional(),
};
const exactlyOne = (v: { token?: string | undefined; code?: string | undefined }) =>
  (v.token === undefined) !== (v.code === undefined);

export const InvitationLookupQuerySchema = z
  .object(invitationSecret)
  .refine(exactlyOne, { message: "token or code" });

export const InvitationLookupSchema = z
  .object({
    clubId: z.uuid(),
    clubName: z.string(),
    kind: z.enum(INVITATION_KINDS),
  })
  .openapi("InvitationLookup");
export type InvitationLookup = z.infer<typeof InvitationLookupSchema>;

export const AcceptInvitationSchema = z
  .object(invitationSecret)
  .strict()
  .refine(exactlyOne, { message: "token or code" })
  .openapi("AcceptInvitation");
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

export const InvitationAcceptedSchema = z
  .object({ clubId: z.uuid(), clubName: z.string(), alreadyMember: z.boolean() })
  .openapi("InvitationAccepted");
export type InvitationAccepted = z.infer<typeof InvitationAcceptedSchema>;

// --- Club managers -------------------------------------------------------

export const ManagerListSchema = z
  .object({
    items: z.array(z.object({ person: PersonSummarySchema, since: z.iso.datetime() })),
  })
  .openapi("ManagerList");
export type ManagerList = z.infer<typeof ManagerListSchema>;

export const AppointManagerSchema = z
  .object({ personId: z.uuid() })
  .strict()
  .openapi("AppointManager");

export const ReassignManagerSchema = z
  .object({
    personId: z.uuid(),
    /** The club's documented request (e.g. board minutes), recorded in the audit event. */
    reason: z.string().trim().min(10).max(1000),
  })
  .strict()
  .openapi("ReassignManager");
export type ReassignManagerInput = z.infer<typeof ReassignManagerSchema>;

export const ManagerParamsSchema = z.object({ clubId: z.uuid(), personId: z.uuid() });

export const ProposeHandoverSchema = z
  .object({ toPersonId: z.uuid() })
  .strict()
  .openapi("ProposeHandover");

export const HandoverSchema = z
  .object({
    id: z.uuid(),
    club: z.object({ id: z.uuid(), name: z.string() }),
    from: PersonSummarySchema.nullable(),
    to: PersonSummarySchema.nullable(),
    status: z.enum(HANDOVER_STATUSES),
    expiresAt: z.iso.datetime(),
  })
  .openapi("Handover");
export type HandoverResponse = z.infer<typeof HandoverSchema>;

export const MyHandoversSchema = z
  .object({ incoming: z.array(HandoverSchema), outgoing: z.array(HandoverSchema) })
  .openapi("MyHandovers");
export type MyHandovers = z.infer<typeof MyHandoversSchema>;

export const HandoverParamsSchema = z.object({ handoverId: z.uuid() });
