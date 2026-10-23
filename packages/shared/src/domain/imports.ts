// SPDX-License-Identifier: AGPL-3.0-only
// Adding members by hand and importing them from a file (P1.3b). Staging rows
// carry the file's values for the importing registrar's preview; people in
// responses appear only as PersonSummary or, for rows not imported yet, as
// the row's name through the import presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { GENDERS, GUARDIANSHIP_KINDS, GUARDIANSHIP_RIGHTS, MEMBERSHIP_TYPES } from "./core.ts";
import { NewLinkedPersonSchema } from "./family.ts";
import { RegisterMemberSchema } from "./members.ts";
import {
  EmailSchema,
  PersonalIdentityNumberInputSchema,
  PhoneSchema,
  PostalAddressSchema,
} from "./schemas.ts";

const name = z.string().trim().min(1).max(100);
const rights = z.array(z.enum(GUARDIANSHIP_RIGHTS)).max(GUARDIANSHIP_RIGHTS.length);

// --- Adding a member by hand ---------------------------------------------------

/**
 * A guardian of a member added by hand: an existing member of the club, a
 * new person without login (name, phone), or someone invited by email (the
 * guardianship starts when they accept with that email, ADR 0020: people
 * never have an email).
 */
export const AddMemberGuardianSchema = z
  .object({
    guardian: z.union([
      z.object({ personId: z.uuid() }).strict(),
      z.object({ person: NewLinkedPersonSchema }).strict(),
      z.object({ email: EmailSchema }).strict(),
    ]),
    kind: z.enum(GUARDIANSHIP_KINDS),
    /** The linked kinds only (relative, contact person, step and foster parent). */
    rights: rights.optional(),
    /** Written consent for a linked kind (required for them, like a paper form, P1.3). */
    consentNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type AddMemberGuardianInput = z.input<typeof AddMemberGuardianSchema>;

export const AddMemberSchema = z
  .object({
    givenName: name,
    familyName: name,
    /** Required unless a personal identity number gives it (it must match then). */
    birthDate: z.iso.date().optional(),
    personalIdentityNumber: PersonalIdentityNumberInputSchema.optional(),
    gender: z.enum(GENDERS).optional(),
    phone: PhoneSchema.optional(),
    address: PostalAddressSchema.optional(),
    /** Club-level protected identity: no address is stored. */
    protectedIdentity: z.boolean().default(false),
    membershipType: z.enum(MEMBERSHIP_TYPES).default("active"),
    /** Membership start (the club's time zone); default today. Not in the future. */
    startDate: z.iso.date().optional(),
    groupIds: z.array(z.uuid()).max(50).default([]),
    guardians: z.array(AddMemberGuardianSchema).max(50).default([]),
    /** An adult's own email: an invitation to log in (never stored on the person). */
    invitationEmail: EmailSchema.optional(),
  })
  .strict()
  .refine((v) => v.birthDate !== undefined || v.personalIdentityNumber !== undefined, {
    message: "birthDate or personalIdentityNumber is required",
    path: ["birthDate"],
  })
  .openapi("AddMemberRequest");
export type AddMemberInput = z.input<typeof AddMemberSchema>;

export const AddMemberResultSchema = z
  .object({
    member: RegisterMemberSchema,
    /** Invitations sent (own login and guardians); emails are not echoed. */
    invitationsSent: z.number().int(),
  })
  .openapi("AddMemberResult");
export type AddMemberResult = z.infer<typeof AddMemberResultSchema>;

/** Name parts of a validated input, for services outside the people module (ADR 0022). */
export function nameParts(input: { givenName: string; familyName: string }): {
  given: string;
  family: string;
} {
  return { given: input.givenName, family: input.familyName };
}

// --- Imports -------------------------------------------------------------------

export const MEMBER_IMPORT_STATUSES = [
  "uploaded",
  "parsing",
  "review",
  "importing",
  "done",
  "failed",
  "cancelled",
] as const;
export type MemberImportStatus = (typeof MEMBER_IMPORT_STATUSES)[number];

/** XLSX is reserved: no parser on the licence allow list evaluates no formulas (docs/licensing.md). */
export const MEMBER_IMPORT_FORMATS = ["csv", "xlsx"] as const;
export type MemberImportFormat = (typeof MEMBER_IMPORT_FORMATS)[number];

export const MEMBER_IMPORT_ROW_STATUSES = [
  "new",
  "duplicate",
  "error",
  "skipped",
  "imported",
] as const;
export type MemberImportRowStatus = (typeof MEMBER_IMPORT_ROW_STATUSES)[number];

/** How the registrar resolved a possible duplicate (or an already imported row). */
export const MEMBER_IMPORT_RESOLUTIONS = ["same_person", "different_person"] as const;
export type MemberImportResolution = (typeof MEMBER_IMPORT_RESOLUTIONS)[number];

/** Limits (docs/security.md, "Uploads"). */
export const MEMBER_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const MEMBER_IMPORT_MAX_ROWS = 20_000;

/** Fields of a member row a file column can map to. */
export const MEMBER_IMPORT_MEMBER_FIELDS = [
  "givenName",
  "familyName",
  /** "Given Family" in one column (split at the last space). */
  "fullName",
  "birthDate",
  "personalIdentityNumber",
  "gender",
  "phone",
  "email",
  "street",
  "postalCode",
  "city",
  "membershipType",
  "startDate",
  "memberNumber",
  /** Group names, separated by `,` or `;` or `|`. */
  "groups",
  "protected",
  /** Rows with the same key are one family (one row per guardian). */
  "familyKey",
  /** On a guardian's own row (family key): the guardian's kind; the row is not a member. */
  "relation",
] as const;
export type MemberImportMemberField = (typeof MEMBER_IMPORT_MEMBER_FIELDS)[number];

/** Fields of the n:th guardian on a member's row (`guardian.1.givenName`, …), any number of them. */
export const MEMBER_IMPORT_GUARDIAN_FIELDS = [
  "givenName",
  "familyName",
  "fullName",
  "phone",
  "email",
  "kind",
] as const;
export type MemberImportGuardianField = (typeof MEMBER_IMPORT_GUARDIAN_FIELDS)[number];

const GUARDIAN_TARGET = /^guardian\.([1-9][0-9]?)\.([a-zA-Z]+)$/;

/** `givenName`, or `guardian.<n>.<field>` with n from 1 to 99. */
export const MemberImportTargetSchema = z
  .string()
  .max(40)
  .refine((v) => {
    if ((MEMBER_IMPORT_MEMBER_FIELDS as readonly string[]).includes(v)) return true;
    const match = GUARDIAN_TARGET.exec(v);
    return (
      match !== null && (MEMBER_IMPORT_GUARDIAN_FIELDS as readonly string[]).includes(match[2]!)
    );
  }, "unknown import field");

export function parseImportTarget(
  target: string,
):
  | { kind: "member"; field: MemberImportMemberField }
  | { kind: "guardian"; index: number; field: MemberImportGuardianField }
  | null {
  if ((MEMBER_IMPORT_MEMBER_FIELDS as readonly string[]).includes(target)) {
    return { kind: "member", field: target as MemberImportMemberField };
  }
  const match = GUARDIAN_TARGET.exec(target);
  if (match && (MEMBER_IMPORT_GUARDIAN_FIELDS as readonly string[]).includes(match[2]!)) {
    return {
      kind: "guardian",
      index: Number(match[1]),
      field: match[2] as MemberImportGuardianField,
    };
  }
  return null;
}

/** File column (0-based index as a string) → field; unmapped columns are ignored. */
export const MemberImportColumnMapSchema = z
  .record(z.string().regex(/^[0-9]{1,3}$/), MemberImportTargetSchema)
  .refine((map) => {
    const targets = Object.values(map);
    return new Set(targets).size === targets.length;
  }, "a field is mapped twice");
export type MemberImportColumnMap = z.infer<typeof MemberImportColumnMapSchema>;

export const MemberImportOptionsSchema = z
  .object({
    /** For rows without a membership type column (or an empty cell). */
    membershipType: z.enum(MEMBERSHIP_TYPES).default("active"),
    /** For rows without a start date; default the day of the import. */
    startDate: z.iso.date().nullable().default(null),
    /** Keep the file's member numbers (unique in the club) or assign new ones. */
    memberNumbers: z.enum(["keep", "assign"]).default("assign"),
    /** Own-login invitations for adults and invitations for guardians with an email. */
    sendInvitations: z.boolean().default(false),
    /** Written consent for linked guardians (relatives, contact persons, step and foster parents). */
    consentNote: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();
export type MemberImportOptions = z.infer<typeof MemberImportOptionsSchema>;

/**
 * Codes on a row (never values). Errors stop the row; the others are
 * information the preview shows.
 */
export const MEMBER_IMPORT_ERROR_ISSUES = [
  "name_missing",
  "birth_date_missing",
  "birth_date_invalid",
  "birth_date_in_future",
  "personal_identity_number_invalid",
  "personal_identity_number_mismatch",
  "gender_invalid",
  "phone_invalid",
  "email_invalid",
  "address_incomplete",
  "membership_type_invalid",
  "start_date_invalid",
  "member_number_invalid",
  "member_number_taken",
  "member_number_repeated",
  "group_not_found",
  "guardian_name_missing",
  "guardian_kind_invalid",
  "guardian_phone_invalid",
  "guardian_email_invalid",
  "guardian_consent_note_missing",
  "relation_invalid",
  "family_without_member",
  "repeated_in_file",
  "import_failed",
] as const;
export const MEMBER_IMPORT_NOTICE_ISSUES = [
  /** A minor's email became a guardian's email (never stored on the child). */
  "minor_email_moved",
  /** A minor's email was dropped: no guardian without an email on the row. */
  "minor_email_dropped",
  /** The row is protected: its address is not stored. */
  "protected_address_dropped",
  /** The person is already in the club with the same key (re-run): skipped. */
  "already_in_club",
  /** Someone in the club has the same birth date and a similar name. */
  "possible_duplicate",
  /** A guardian is already a member of the club and is linked to them. */
  "guardian_is_member",
  "unknown_columns",
] as const;
export const MEMBER_IMPORT_ISSUES = [
  ...MEMBER_IMPORT_ERROR_ISSUES,
  ...MEMBER_IMPORT_NOTICE_ISSUES,
] as const;
export type MemberImportIssue = (typeof MEMBER_IMPORT_ISSUES)[number];
export const isImportErrorIssue = (issue: string): boolean =>
  (MEMBER_IMPORT_ERROR_ISSUES as readonly string[]).includes(issue);

export const MemberImportCountsSchema = z.object({
  rows: z.number().int(),
  new: z.number().int(),
  duplicate: z.number().int(),
  error: z.number().int(),
  skipped: z.number().int(),
  imported: z.number().int(),
  /** Guardians on the rows (one per person, also when they have several children). */
  guardians: z.number().int(),
  /** Invitations that will be (or were) sent. */
  invitations: z.number().int(),
});
export type MemberImportCounts = z.infer<typeof MemberImportCountsSchema>;

export const EMPTY_IMPORT_COUNTS: MemberImportCounts = {
  rows: 0,
  new: 0,
  duplicate: 0,
  error: 0,
  skipped: 0,
  imported: 0,
  guardians: 0,
  invitations: 0,
};

export const MemberImportParamsSchema = z.object({ clubId: z.uuid(), importId: z.uuid() });
export const MemberImportRowParamsSchema = z.object({
  clubId: z.uuid(),
  importId: z.uuid(),
  rowNumber: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMBER_IMPORT_MAX_ROWS + 1),
});

export const CreateMemberImportSchema = z
  .object({
    format: z.enum(MEMBER_IMPORT_FORMATS).default("csv"),
    /** The file's size in bytes (the upload link only accepts files up to the limit). */
    size: z.number().int().min(1).max(MEMBER_IMPORT_MAX_BYTES),
  })
  .strict()
  .openapi("CreateMemberImportRequest");
export type CreateMemberImportInput = z.input<typeof CreateMemberImportSchema>;

export const UpdateMemberImportMappingSchema = z
  .object({ columnMap: MemberImportColumnMapSchema, options: MemberImportOptionsSchema })
  .strict()
  .openapi("UpdateMemberImportMappingRequest");
export type UpdateMemberImportMappingInput = z.input<typeof UpdateMemberImportMappingSchema>;

export const UpdateMemberImportRowSchema = z
  .object({ action: z.enum(["skip", "unskip", "same_person", "different_person"]) })
  .strict()
  .openapi("UpdateMemberImportRowRequest");
export type UpdateMemberImportRowInput = z.input<typeof UpdateMemberImportRowSchema>;

export const MemberImportRowsQuerySchema = z.object({
  status: z.enum(MEMBER_IMPORT_ROW_STATUSES).optional(),
  /** The last row number of the previous page. */
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MemberImportRowsQuery = z.infer<typeof MemberImportRowsQuerySchema>;

export const MemberImportColumnSchema = z.object({
  index: z.number().int(),
  header: z.string(),
  /** A value from the first rows with one (for the mapping dropdowns). */
  sample: z.string().nullable(),
  /** The recognised field, or null (ignored unless mapped). */
  suggested: z.string().nullable(),
});

export const MemberImportSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(MEMBER_IMPORT_STATUSES),
    format: z.enum(MEMBER_IMPORT_FORMATS),
    /** Null when the viewer may not see the importer (protected identity). */
    createdBy: PersonSummarySchema.nullable(),
    mine: z.boolean(),
    columns: z.array(MemberImportColumnSchema),
    columnMap: z.record(z.string(), z.string()),
    options: MemberImportOptionsSchema,
    counts: MemberImportCountsSchema,
    /** The recognised source format (`idrottonline`) or null. */
    detectedSource: z.string().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .openapi("MemberImport");
export type MemberImport = z.infer<typeof MemberImportSchema>;

export const MemberImportCreatedSchema = z
  .object({
    import: MemberImportSchema,
    /** PUT the file here (Content-Type text/csv), within 15 minutes. */
    uploadUrl: z.url(),
    uploadExpiresAt: z.iso.datetime({ offset: true }),
  })
  .openapi("MemberImportCreated");
export type MemberImportCreated = z.infer<typeof MemberImportCreatedSchema>;

export const MemberImportListSchema = z
  .object({ items: z.array(MemberImportSchema), nextCursor: z.uuid().nullable() })
  .openapi("MemberImportList");
export type MemberImportList = z.infer<typeof MemberImportListSchema>;

export const MemberImportRowSchema = z
  .object({
    rowNumber: z.number().int(),
    status: z.enum(MEMBER_IMPORT_ROW_STATUSES),
    issues: z.array(z.enum(MEMBER_IMPORT_ISSUES)),
    /** The name in the file; null on rows without one. */
    name: z.string().nullable(),
    birthDate: z.iso.date().nullable(),
    protected: z.boolean(),
    /** A guardian's own row (one row per guardian with a family key). */
    guardianRow: z.boolean(),
    guardians: z.array(
      z.object({
        name: z.string().nullable(),
        kind: z.enum(GUARDIANSHIP_KINDS).nullable(),
        /** Will be invited by email (the address is not shown). */
        invited: z.boolean(),
      }),
    ),
    groups: z.array(z.string()),
    /** The club's member this row may be (possible duplicate), or the person it became. */
    match: PersonSummarySchema.nullable(),
    resolution: z.enum(MEMBER_IMPORT_RESOLUTIONS).nullable(),
  })
  .openapi("MemberImportRow");
export type MemberImportRow = z.infer<typeof MemberImportRowSchema>;

export const MemberImportRowPageSchema = z
  .object({ items: z.array(MemberImportRowSchema), nextCursor: z.number().int().nullable() })
  .openapi("MemberImportRowPage");
export type MemberImportRowPage = z.infer<typeof MemberImportRowPageSchema>;

// --- Form input --------------------------------------------------------------

/** How many guardian fieldsets the "Add member" form may post. */
export const ADD_MEMBER_FORM_MAX_GUARDIANS = 50;

/**
 * "Add member" from the web form's fields (validated by AddMemberSchema in
 * the API): the person, membership, groups and the guardian fieldsets
 * `guardian.<i>.<field>` (source `member` with a person ID, or `new` with a
 * name, phone and optional email: with an email the guardian is invited).
 */
export function addMemberFormInput(
  field: (name: string) => string,
  all: (name: string) => string[],
): AddMemberInput {
  const opt = (name: string) => field(name) || undefined;
  const pin = field("personalIdentityNumber");
  const [street, postalCode, city] = [field("street"), field("postalCode"), field("city")];
  const guardians: AddMemberGuardianInput[] = [];
  for (let i = 0; i < ADD_MEMBER_FORM_MAX_GUARDIANS; i++) {
    const g = (name: string) => field(`guardian.${i}.${name}`);
    const source = g("source");
    if (!source) continue;
    const kind = g("kind") as AddMemberGuardianInput["kind"];
    const consentNote = g("consentNote") || undefined;
    const rights = all(`guardian.${i}.right`) as AddMemberGuardianInput["rights"];
    const common = {
      kind,
      ...(consentNote ? { consentNote } : {}),
      ...(rights && rights.length > 0 ? { rights } : {}),
    };
    if (source === "member") {
      if (g("personId")) guardians.push({ guardian: { personId: g("personId") }, ...common });
    } else if (g("email")) {
      guardians.push({ guardian: { email: g("email") }, ...common });
    } else if (g("givenName") || g("familyName")) {
      const phone = g("phone");
      guardians.push({
        guardian: {
          person: {
            givenName: g("givenName"),
            familyName: g("familyName"),
            ...(phone ? { phone } : {}),
          },
        },
        ...common,
      });
    }
  }
  return {
    givenName: field("givenName"),
    familyName: field("familyName"),
    ...(opt("birthDate") ? { birthDate: field("birthDate") } : {}),
    ...(pin ? { personalIdentityNumber: { country: field("country"), value: pin } } : {}),
    ...(opt("gender") ? { gender: field("gender") as AddMemberInput["gender"] } : {}),
    ...(opt("phone") ? { phone: field("phone") } : {}),
    ...(street || postalCode || city
      ? { address: { street, postalCode, city, country: field("country") } }
      : {}),
    protectedIdentity: field("protectedIdentity") === "on",
    ...(opt("membershipType")
      ? { membershipType: field("membershipType") as AddMemberInput["membershipType"] }
      : {}),
    ...(opt("startDate") ? { startDate: field("startDate") } : {}),
    groupIds: all("groupId"),
    guardians,
    ...(opt("invitationEmail") ? { invitationEmail: field("invitationEmail") } : {}),
  };
}
