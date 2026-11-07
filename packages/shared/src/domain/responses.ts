// SPDX-License-Identifier: AGPL-3.0-only
// Request parameters and responses of the read endpoints (P0.7). People
// appear only as PersonSummary (or an ActorReference), produced by the
// PersonPresenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { PERMISSIONS } from "../permissions.ts";
import { z } from "../zod.ts";
import {
  ADMISSION_MODES,
  CLUB_ROLES,
  CLUB_STATUSES,
  GENDER_CATEGORIES,
  GENDERS,
  GROUP_FUNCTIONS,
  GROUP_KINDS,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  JOIN_POLICIES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_TYPES,
} from "./core.ts";
import { PostalAddressSchema } from "./schemas.ts";

export const ClubParamsSchema = z.object({ clubId: z.uuid() });
export const GroupParamsSchema = z.object({ groupId: z.uuid() });
export const PersonParamsSchema = z.object({ personId: z.uuid() });
export const PersonQuerySchema = z.object({
  /** The club whose view of the person is read; without it only the person and their guardians see the profile. */
  clubId: z.uuid().optional(),
});

/** Keyset pagination: `cursor` is the `nextCursor` of the previous page (an ID, never data). */
export const PageQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Who did something, in history and audit views: a hidden protected person
 * is only "protected". Clients treat unknown kinds as "system" (ADR 0029).
 */
export const ActorReferenceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), person: PersonSummarySchema }),
    z.object({ kind: z.literal("protected") }),
    /** A background job (P1.9: the job's name, e.g. attendance:retention), migration or the database. */
    z.object({ kind: z.literal("system"), job: z.string().optional() }),
    /** A person whose data was erased (P1.9: "Deleted user"). */
    z.object({ kind: z.literal("erased") }),
    /** A platform operator (support access), never named (P1.9). */
    z.object({ kind: z.literal("operator") }),
  ])
  .openapi("ActorReference");
export type ActorReference = z.infer<typeof ActorReferenceSchema>;

export const ClubSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    shortName: z.string().nullable(),
    slug: z.string(),
    country: z.string(),
    logo: z.string().nullable(),
  })
  .openapi("ClubSummary");

export const ClubSchema = ClubSummarySchema.extend({
  defaultLocale: z.string(),
  timeZone: z.string(),
  currency: z.string(),
  status: z.enum(CLUB_STATUSES),
  joinPolicy: z.enum(JOIN_POLICIES),
}).openapi("Club");
export type ClubResponse = z.infer<typeof ClubSchema>;

/** A club with its managers (GET /clubs/{clubId}). */
export const ClubDetailSchema = ClubSchema.extend({
  managers: z.array(PersonSummarySchema),
  /** Contact details (P1.6b), for people related to the club. */
  email: z.string().nullable().optional(),
  organizationNumber: z.string().nullable().optional(),
  address: PostalAddressSchema.nullable().optional(),
  phoneNumbers: z
    .array(z.object({ id: z.uuid(), label: z.string(), number: z.string() }))
    .optional(),
  /** How groups are run (P1.10a): owners appoint co-owners; owners admit new club members (P1.10b). */
  groupSettings: z
    .object({ ownersCanAppointCoOwners: z.boolean(), groupOwnersAdmitToClub: z.boolean() })
    .optional(),
}).openapi("ClubDetail");
export type ClubDetail = z.infer<typeof ClubDetailSchema>;

export const MyClubsSchema = z
  .object({
    clubs: z.array(
      z.object({
        club: ClubSummarySchema.extend({ defaultLocale: z.string(), timeZone: z.string() }),
        /** Null when the person holds a role or employment without a membership. */
        membership: z
          .object({
            status: z.enum(MEMBERSHIP_STATUSES),
            membershipType: z.enum(MEMBERSHIP_TYPES),
          })
          .nullable(),
        roles: z.array(z.enum(CLUB_ROLES)),
        /**
         * Club-level permissions the caller holds in the club (for showing
         * navigation; the API still checks every request). Permissions that
         * need a second factor are listed even without one.
         */
        permissions: z.array(z.enum(PERMISSIONS)),
      }),
    ),
  })
  .openapi("MyClubs");
export type MyClubs = z.infer<typeof MyClubsSchema>;

export const MyWardsSchema = z
  .object({
    wards: z.array(
      z.object({
        person: PersonSummarySchema,
        kind: z.enum(GUARDIANSHIP_KINDS),
        rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)),
        /** Full guardians only (P1.3). */
        birthDate: z.iso.date().nullable().optional(),
        /** Clubs the ward is an active or paused member of. */
        clubs: z.array(z.object({ id: z.uuid(), name: z.string() })).optional(),
        /** Full guardians only: the ward has their own login. */
        hasLogin: z.boolean().optional(),
        /** Full guardians only: from which age "Give own login" is possible (the strictest country pack). */
        ownLoginFromAge: z.number().int().optional(),
      }),
    ),
  })
  .openapi("MyWards");
export type MyWards = z.infer<typeof MyWardsSchema>;

export const GroupSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    parentGroupId: z.uuid().nullable(),
    kind: z.enum(GROUP_KINDS),
    name: z.string(),
    sport: z.string().nullable(),
    birthYearFrom: z.number().int().nullable(),
    birthYearTo: z.number().int().nullable(),
    genderCategory: z.enum(GENDER_CATEGORIES).nullable(),
    level: z.string().nullable(),
    capacity: z.number().int().nullable(),
    admissionMode: z.enum(ADMISSION_MODES),
    archived: z.boolean(),
  })
  .openapi("Group");
export type GroupResponse = z.infer<typeof GroupSchema>;

/** A group with its owners (GET /groups/{groupId}). */
export const GroupDetailSchema = GroupSchema.extend({
  owners: z.array(PersonSummarySchema),
  /** The viewer may edit, archive and delete it (group.update; P1.6b). */
  canManage: z.boolean().optional(),
  /** Never used (no memberships, activities, events or waiting-list entries): it can be deleted. */
  deletable: z.boolean().optional(),
  /**
   * The places today (P1.10a): this season's capacity of the group, else its
   * own; null is unlimited. For those who may edit the group.
   */
  effectiveCapacity: z.number().int().nullable().optional(),
  /** Places taken: open `member` functions (leaders never count). For those who may edit the group. */
  occupied: z.number().int().optional(),
  /** The viewer adds and ends members (group.members.manage, P1.10a). */
  canManageMembers: z.boolean().optional(),
  /** The viewer appoints and removes owners (group.owners.manage, P1.10a). */
  canManageOwners: z.boolean().optional(),
}).openapi("GroupDetail");
export type GroupDetail = z.infer<typeof GroupDetailSchema>;

const MyGroupSchema = z.object({
  group: GroupSchema,
  club: z.object({ id: z.uuid(), name: z.string() }),
  functions: z.array(z.enum(GROUP_FUNCTIONS)),
});

export const MyGroupsSchema = z
  .object({
    /** The caller's groups (the ward's, with X-On-Behalf-Of). */
    groups: z.array(MyGroupSchema),
    /** The groups of the caller's wards (empty when acting on behalf). */
    wards: z.array(z.object({ personId: z.uuid(), groups: z.array(MyGroupSchema) })),
  })
  .openapi("MyGroups");
export type MyGroups = z.infer<typeof MyGroupsSchema>;

export const GroupListSchema = z
  .object({ items: z.array(GroupSchema), nextCursor: z.uuid().nullable() })
  .openapi("GroupList");
export type GroupList = z.infer<typeof GroupListSchema>;

export const GroupMemberListSchema = z
  .object({
    items: z.array(
      z.object({
        person: PersonSummarySchema,
        functions: z.array(z.enum(GROUP_FUNCTIONS)),
        /** Each open function with its ID, for those who end them (group.members.manage, P1.10a). */
        memberships: z
          .array(z.object({ id: z.uuid(), function: z.enum(GROUP_FUNCTIONS) }))
          .optional(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
    /** All active members, including those the viewer does not see (an aggregate, ADR 0022). */
    totalCount: z.number().int(),
  })
  .openapi("GroupMemberList");
export type GroupMemberList = z.infer<typeof GroupMemberListSchema>;

/**
 * A person as seen by the viewer. Fields are left out when the viewer's
 * relationship does not include them (docs/domain-model.md, "Field visibility").
 */
export const PersonProfileSchema = z
  .object({
    person: PersonSummarySchema,
    birthDate: z.iso.date().nullable().optional(),
    gender: z.enum(GENDERS).nullable().optional(),
    phone: z.string().nullable().optional(),
    address: PostalAddressSchema.nullable().optional(),
    club: z
      .object({
        clubId: z.uuid(),
        memberNumber: z.number().int().optional(),
        membership: z
          .object({
            status: z.enum(MEMBERSHIP_STATUSES),
            membershipType: z.enum(MEMBERSHIP_TYPES),
          })
          .nullable()
          .optional(),
        groups: z
          .array(z.object({ groupId: z.uuid(), functions: z.array(z.enum(GROUP_FUNCTIONS)) }))
          .optional(),
      })
      .optional(),
    guardians: z
      .array(
        z.object({
          person: PersonSummarySchema,
          kind: z.enum(GUARDIANSHIP_KINDS),
          phone: z.string().nullable().optional(),
        }),
      )
      .optional(),
  })
  .openapi("PersonProfile");
export type PersonProfile = z.infer<typeof PersonProfileSchema>;
