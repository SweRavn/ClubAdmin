// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents (P2.4, ADR 0049 decision 1B, ADR 0037): series of
// statutes, minutes and policies (folders of the purpose `series`), whose
// documents are Markdown texts drafted, adopted (date, meeting, effective
// date; the adopted version is locked), superseded or archived. Settings the
// adopted text marks (`{{setting key = value}}`) become the club's board
// decisions. People appear only as PersonSummary from the presenter
// (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { DECISION_BODIES } from "./core.ts";
import {
  AudienceEntrySchema,
  AudienceInputSchema,
  GOVERNING_STATUSES,
  SERIES_KINDS,
} from "./documents.ts";

/** A governing document's text is at most this long (characters). */
export const GOVERNING_BODY_MAX = 200_000;

const name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    .refine((value) => !/[/\\\u0000-\u001f]/.test(value), { message: "invalid_name" });

export const DocumentSeriesQuerySchema = z.object({
  /** A group's series (a board's minutes); none: the club's. */
  groupId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DocumentSeriesQuery = z.infer<typeof DocumentSeriesQuerySchema>;

export const DocumentSeriesSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    groupId: z.uuid().nullable(),
    name: z.string(),
    seriesKind: z.enum(SERIES_KINDS),
    createdAt: z.iso.datetime(),
  })
  .openapi("DocumentSeries");
export type DocumentSeries = z.infer<typeof DocumentSeriesSchema>;

export const DocumentSeriesPageSchema = z
  .object({
    items: z.array(DocumentSeriesSchema),
    nextCursor: z.uuid().nullable(),
    /** The caller may create series and governing documents. */
    canManage: z.boolean(),
  })
  .openapi("DocumentSeriesPage");
export type DocumentSeriesPage = z.infer<typeof DocumentSeriesPageSchema>;

export const CreateDocumentSeriesSchema = z
  .object({
    name: name(120),
    seriesKind: z.enum(SERIES_KINDS),
    /** A group's series (e.g. a board's minutes); none: the club's. */
    groupId: z.uuid().nullish(),
    /** None: the whole club (the club's series) or the group (a group's). */
    audience: AudienceInputSchema.nullish(),
  })
  .strict()
  .openapi("CreateDocumentSeries");
export type CreateDocumentSeriesInput = z.infer<typeof CreateDocumentSeriesSchema>;

export const GoverningDocumentParamsSchema = z.object({
  clubId: z.uuid(),
  documentId: z.uuid(),
});
export const GoverningVersionParamsSchema = GoverningDocumentParamsSchema.extend({
  versionId: z.uuid(),
});

/** The meeting that adopted a version: an activity (a board meeting) or an event (the annual meeting). */
export const AdoptingMeetingSchema = z
  .object({ kind: z.enum(["activity", "event"]), id: z.uuid() })
  .openapi("AdoptingMeeting");
export type AdoptingMeeting = z.infer<typeof AdoptingMeetingSchema>;

export const GoverningAdoptionSchema = z
  .object({
    adoptedOn: z.iso.date(),
    effectiveFrom: z.iso.date(),
    meeting: AdoptingMeetingSchema.nullable(),
    /** Who recorded the adoption; none: hidden (protected identity) or no longer known. */
    recordedBy: PersonSummarySchema.nullable(),
    recordedAt: z.iso.datetime(),
  })
  .openapi("GoverningAdoption");
export type GoverningAdoption = z.infer<typeof GoverningAdoptionSchema>;

export const SIGNER_ROLES = ["chair", "secretary", "adjuster", "other"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const GoverningSignerSchema = z
  .object({
    signatureId: z.uuid(),
    /** None: hidden (protected identity). */
    person: PersonSummarySchema.nullable(),
    role: z.enum(SIGNER_ROLES),
    /** Set once signed, with the level (`simple`) and the provider. */
    signedAt: z.iso.datetime().nullable(),
    level: z.enum(["simple"]).nullable(),
    provider: z.string().nullable(),
    /** The caller is this signer and may sign now. */
    mine: z.boolean(),
  })
  .openapi("GoverningSigner");
export type GoverningSigner = z.infer<typeof GoverningSignerSchema>;

export const GoverningVersionSchema = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    /** SHA-256 of the text (hex). */
    sha256: z.string().nullable(),
    /** Who last saved it; none: hidden (protected identity) or no longer known. */
    editedBy: PersonSummarySchema.nullable(),
    createdAt: z.iso.datetime(),
    /** Set once adopted (the version is then locked). */
    adoption: GoverningAdoptionSchema.nullable(),
    /** Who is to sign it and who has (P2.4 part C). */
    signers: z.array(GoverningSignerSchema),
    /** The signature page (PDF) exists: every signer signed. */
    signaturePage: z.boolean(),
  })
  .openapi("GoverningVersion");
export type GoverningVersion = z.infer<typeof GoverningVersionSchema>;

export const GoverningVersionTextSchema = GoverningVersionSchema.extend({
  /** The Markdown text, with settings markers. */
  body: z.string(),
}).openapi("GoverningVersionText");
export type GoverningVersionText = z.infer<typeof GoverningVersionTextSchema>;

export const GoverningDocumentRefSchema = z
  .object({ id: z.uuid(), name: z.string() })
  .openapi("GoverningDocumentRef");

export const GoverningDocumentSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    groupId: z.uuid().nullable(),
    series: z.object({
      id: z.uuid(),
      name: z.string(),
      seriesKind: z.enum(SERIES_KINDS),
    }),
    name: z.string(),
    status: z.enum(GOVERNING_STATUSES),
    /** The version in force (the latest adopted one). */
    current: GoverningVersionTextSchema.nullable(),
    /** The draft being worked on (those who manage governing documents only). */
    draft: GoverningVersionTextSchema.nullable(),
    /** Every version the caller may see, newest first, without text. */
    versions: z.array(GoverningVersionSchema),
    supersededBy: GoverningDocumentRefSchema.nullable(),
    supersedes: z.array(GoverningDocumentRefSchema),
    /** The audience that applies (the document's own or its series'). */
    audience: z.array(AudienceEntrySchema),
    canManage: z.boolean(),
    canAdopt: z.boolean(),
  })
  .openapi("GoverningDocument");
export type GoverningDocument = z.infer<typeof GoverningDocumentSchema>;

export const CreateGoverningDocumentSchema = z
  .object({
    /** The series (a folder of the purpose `series`). */
    seriesId: z.uuid(),
    name: name(200),
    body: z.string().max(GOVERNING_BODY_MAX),
  })
  .strict()
  .openapi("CreateGoverningDocument");
export type CreateGoverningDocumentInput = z.infer<typeof CreateGoverningDocumentSchema>;

export const UpdateGoverningDocumentSchema = z
  .object({
    name: name(200).optional(),
    /** The draft's text; when the latest version is adopted, a new draft version. */
    body: z.string().max(GOVERNING_BODY_MAX).optional(),
  })
  .strict()
  .openapi("UpdateGoverningDocument");
export type UpdateGoverningDocumentInput = z.infer<typeof UpdateGoverningDocumentSchema>;

export const AdoptGoverningDocumentSchema = z
  .object({
    /** The draft version adopted (it must still be the draft: no change since it was read). */
    versionId: z.uuid(),
    adoptedOn: z.iso.date(),
    /** None: the day it was adopted. */
    effectiveFrom: z.iso.date().nullish(),
    meeting: AdoptingMeetingSchema.nullish(),
    /** Who decided the settings the text marks (needed when it marks any). */
    decisionBody: z.enum(DECISION_BODIES).nullish(),
    /** The minutes' paragraph ("§ 7"); none: the document's name and version. */
    reference: z.string().trim().min(1).max(200).nullish(),
    /** Other governing documents of the club this one replaces. */
    supersedes: z.array(z.uuid()).max(20).optional(),
  })
  .strict()
  .openapi("AdoptGoverningDocument");
export type AdoptGoverningDocumentInput = z.infer<typeof AdoptGoverningDocumentSchema>;

export const GoverningDocumentCreatedSchema = z
  .object({ id: z.uuid(), versionId: z.uuid() })
  .openapi("GoverningDocumentCreated");

// --- Signing (P2.4 part C) -------------------------------------------------------

export const SignatureVersionParamsSchema = z.object({
  clubId: z.uuid(),
  documentId: z.uuid(),
  versionId: z.uuid(),
});

export const PutSignersSchema = z
  .object({
    /** The signers of the version: signed ones stay, unsigned ones not given are removed. */
    signers: z.array(z.object({ personId: z.uuid(), role: z.enum(SIGNER_ROLES) }).strict()).max(10),
  })
  .strict()
  .openapi("PutSigners");
export type PutSignersInput = z.infer<typeof PutSignersSchema>;

export const SignedSchema = z
  .object({ signedAt: z.iso.datetime(), sha256: z.string(), level: z.enum(["simple"]) })
  .openapi("Signed");

export const MySignatureRequestSchema = z
  .object({
    signatureId: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    documentId: z.uuid(),
    documentName: z.string(),
    versionId: z.uuid(),
    versionNumber: z.number().int(),
    role: z.enum(SIGNER_ROLES),
    requestedAt: z.iso.datetime(),
  })
  .openapi("MySignatureRequest");
export type MySignatureRequest = z.infer<typeof MySignatureRequestSchema>;

export const MySignatureRequestListSchema = z
  .object({ items: z.array(MySignatureRequestSchema) })
  .openapi("MySignatureRequestList");
export type MySignatureRequestList = z.infer<typeof MySignatureRequestListSchema>;
