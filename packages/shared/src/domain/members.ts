// SPDX-License-Identifier: AGPL-3.0-only
// The member register (P1.2): search and filters, the register's field sets
// per access level, membership changes and exports. People appear only as
// PersonSummary (PersonPresenter, ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  CLUB_ROLES,
  CONSENT_PURPOSES,
  GENDERS,
  GROUP_FUNCTIONS,
  GUARDIANSHIP_KINDS,
  MEMBERSHIP_TYPES,
} from "./core.ts";
import { PostalAddressSchema } from "./schemas.ts";

/** What a viewer sees of the register: everything, or the board's list. */
export const REGISTER_ACCESS_LEVELS = ["full", "limited"] as const;
export type RegisterAccess = (typeof REGISTER_ACCESS_LEVELS)[number];

/** Membership statuses in the register (`applied` is legacy, ADR 0018). */
export const REGISTER_STATUSES = ["active", "paused", "left"] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

export const REGISTER_SORTS = ["name", "member_number", "joined"] as const;
export type RegisterSort = (typeof REGISTER_SORTS)[number];

export const MEMBER_EXPORT_STATUSES = ["queued", "ready", "failed", "expired"] as const;
export type MemberExportStatus = (typeof MEMBER_EXPORT_STATUSES)[number];

/** CSV columns, in file order (headers in the requester's language). */
export const MEMBER_EXPORT_COLUMNS = [
  "name",
  "memberNumber",
  "birthDate",
  "gender",
  "status",
  "membershipType",
  "joinedOn",
  "leftOn",
  "groups",
  "roles",
  "phone",
  "address",
  "guardians",
  "missingConsents",
] as const;
export type MemberExportColumn = (typeof MEMBER_EXPORT_COLUMNS)[number];

/** Filters the limited register (board roles) may use; the rest need full access. */
export const LIMITED_REGISTER_FILTERS = ["q", "type", "groupId"] as const;

/** A comma-separated query parameter of enum values (`status=active,paused`). */
const csv = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(200)
    .transform((s) => [...new Set(s.split(",").filter((v) => v !== ""))])
    .pipe(z.array(z.enum(values)).min(1));

const year = z.coerce.number().int().min(1900).max(2100);

/** The register's filters; shared by the list, the facets and exports. */
export const RegisterFilterSchema = z.object({
  /** Part of the name, or a member number. */
  q: z.string().trim().min(1).max(100).optional(),
  /** Default: active and paused. */
  status: z.array(z.enum(REGISTER_STATUSES)).min(1).optional(),
  type: z.array(z.enum(MEMBERSHIP_TYPES)).min(1).optional(),
  groupId: z.uuid().optional(),
  role: z.enum(CLUB_ROLES).optional(),
  /** Birth year range (inclusive). */
  bornFrom: year.optional(),
  bornTo: year.optional(),
  /** Only people who shared their gender with the club. */
  gender: z.enum(GENDERS).optional(),
  /** Members without an active consent for this purpose. */
  missingConsent: z.enum(CONSENT_PURPOSES).optional(),
});
export type RegisterFilter = z.infer<typeof RegisterFilterSchema>;

export const RegisterQuerySchema = RegisterFilterSchema.extend({
  status: csv(REGISTER_STATUSES).optional(),
  type: csv(MEMBERSHIP_TYPES).optional(),
  sort: z.enum(REGISTER_SORTS).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RegisterQuery = z.infer<typeof RegisterQuerySchema>;

export const RegisterGroupSchema = z.object({
  groupId: z.uuid(),
  name: z.string(),
  functions: z.array(z.enum(GROUP_FUNCTIONS)),
});

/**
 * A row of the register. `limited` access gets person, member number,
 * membership type and groups; the other fields only with `full` access.
 * Phone, address and gender only if the person shared them with the club.
 */
export const RegisterMemberSchema = z
  .object({
    person: PersonSummarySchema,
    memberNumber: z.number().int(),
    membershipType: z.enum(MEMBERSHIP_TYPES),
    groups: z.array(RegisterGroupSchema),
    birthDate: z.iso.date().nullable().optional(),
    membership: z
      .object({
        status: z.enum(REGISTER_STATUSES),
        validFrom: z.iso.datetime({ offset: true }),
        validTo: z.iso.datetime({ offset: true }).nullable(),
      })
      .optional(),
    roles: z.array(z.enum(CLUB_ROLES)).optional(),
    phone: z.string().nullable().optional(),
    address: PostalAddressSchema.nullable().optional(),
    gender: z.enum(GENDERS).nullable().optional(),
    guardians: z
      .array(
        z.object({
          person: PersonSummarySchema,
          kind: z.enum(GUARDIANSHIP_KINDS),
          phone: z.string().nullable(),
        }),
      )
      .optional(),
    missingConsents: z.array(z.enum(CONSENT_PURPOSES)).optional(),
  })
  .openapi("RegisterMember");
export type RegisterMember = z.infer<typeof RegisterMemberSchema>;

export const RegisterPageSchema = z
  .object({
    access: z.enum(REGISTER_ACCESS_LEVELS),
    items: z.array(RegisterMemberSchema),
    nextCursor: z.uuid().nullable(),
    /**
     * All matches, protected members included without identity; with a name
     * search only the ones the viewer may see (a count would reveal them).
     */
    totalCount: z.number().int(),
  })
  .openapi("RegisterPage");
export type RegisterPage = z.infer<typeof RegisterPageSchema>;

const counts = <T extends readonly [string, ...string[]]>(values: T) =>
  z.array(z.object({ value: z.enum(values), count: z.number().int() }));

export const RegisterFacetsSchema = z
  .object({
    access: z.enum(REGISTER_ACCESS_LEVELS),
    /** Full access only. */
    statuses: counts(REGISTER_STATUSES).optional(),
    types: counts(MEMBERSHIP_TYPES),
    groups: z.array(z.object({ groupId: z.uuid(), name: z.string(), count: z.number().int() })),
  })
  .openapi("RegisterFacets");
export type RegisterFacets = z.infer<typeof RegisterFacetsSchema>;

// --- Membership changes ---------------------------------------------------

export const MemberParamsSchema = z.object({ clubId: z.uuid(), personId: z.uuid() });

/**
 * Pause, resume or end a membership, or change its type. Ending takes an
 * optional date (today or earlier; default now) and ends groups, group
 * ownerships and club roles like leaving does.
 */
export const UpdateMembershipSchema = z
  .object({
    status: z.enum(REGISTER_STATUSES).optional(),
    endedOn: z.iso.date().optional(),
    membershipType: z.enum(MEMBERSHIP_TYPES).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.membershipType !== undefined, {
    message: "status or membershipType is required",
  })
  .refine((v) => v.endedOn === undefined || v.status === "left", {
    message: "endedOn only with status left",
    path: ["endedOn"],
  })
  .openapi("UpdateMembershipRequest");
export type UpdateMembershipInput = z.infer<typeof UpdateMembershipSchema>;

export const MembershipResultSchema = z
  .object({
    personId: z.uuid(),
    status: z.enum(REGISTER_STATUSES),
    membershipType: z.enum(MEMBERSHIP_TYPES),
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }).nullable(),
  })
  .openapi("Membership");
export type MembershipResult = z.infer<typeof MembershipResultSchema>;

// --- Exports ----------------------------------------------------------------

export const CreateMemberExportSchema = z
  .object({
    filter: RegisterFilterSchema.strict().default({}),
    columns: z
      .array(z.enum(MEMBER_EXPORT_COLUMNS))
      .min(1)
      .transform((cs) => MEMBER_EXPORT_COLUMNS.filter((c) => cs.includes(c))),
    /** Protected members, marked "do not share" in their own column. */
    includeProtected: z.boolean().default(false),
  })
  .strict()
  .openapi("CreateMemberExportRequest");
export type CreateMemberExportInput = z.input<typeof CreateMemberExportSchema>;

export const MemberExportParamsSchema = z.object({ clubId: z.uuid(), exportId: z.uuid() });

export const MemberExportSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(MEMBER_EXPORT_STATUSES),
    /** Null when the viewer may not see the requester (protected identity). */
    requestedBy: PersonSummarySchema.nullable(),
    /** The caller asked for it (only they can download it). */
    mine: z.boolean(),
    columns: z.array(z.enum(MEMBER_EXPORT_COLUMNS)),
    includeProtected: z.boolean(),
    rowCount: z.number().int().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    errorCode: z.string().nullable(),
  })
  .openapi("MemberExport");
export type MemberExport = z.infer<typeof MemberExportSchema>;

export const MemberExportListSchema = z
  .object({ items: z.array(MemberExportSchema), nextCursor: z.uuid().nullable() })
  .openapi("MemberExportList");
export type MemberExportList = z.infer<typeof MemberExportListSchema>;

export const MemberExportDownloadSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime({ offset: true }) })
  .openapi("MemberExportDownload");
export type MemberExportDownload = z.infer<typeof MemberExportDownloadSchema>;
