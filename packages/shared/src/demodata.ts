// SPDX-License-Identifier: AGPL-3.0-only
// Schemas of the demo data files in docs/demodata/ (ADR 0026), read by the
// seed runner in apps/api/src/seed. People, clubs and groups are referred to
// by a short key ("anna", "svk", "svk-f2017"); IDs are fixed so tests and bug
// reports can refer to them. Times are relative to the day of seeding:
// "now", "-6y", "-14mo", "-10d", "+3d".

import {
  ADMISSION_MODES,
  CLUB_ROLES,
  CONSENT_PURPOSES,
  EMPLOYMENT_TYPES,
  GENDER_CATEGORIES,
  GENDERS,
  GROUP_FUNCTIONS,
  GROUP_KINDS,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  JOIN_POLICIES,
  MEMBERSHIP_TYPES,
  SHAREABLE_PERSON_FIELDS,
  WAITLIST_STATUSES,
} from "./domain/core.ts";
import { PostalAddressSchema } from "./domain/schemas.ts";
import { z } from "./zod.ts";

const key = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower-case key");
/** Relative to the day of seeding: now, or a signed amount of years, months or days. */
export const RelativeTimeSchema = z
  .string()
  .regex(/^(now|[+-]\d+(y|mo|d))$/, 'relative time such as "now", "-6y", "-14mo", "+3d"');
export type RelativeTime = z.infer<typeof RelativeTimeSchema>;

/** Reserved test data only (docs/seed-data.md, "Rules"). */
const testEmail = z
  .string()
  .regex(/^[a-z0-9.+-]+@[a-z0-9.-]+\.test$/, "emails in the reserved .test domain");

export const DemoPersonaSchema = z
  .object({
    key,
    /** Number in the persona table of docs/seed-data.md. */
    number: z.number().int().positive(),
    id: z.uuid(),
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    /** Age on the day of seeding (birth date computed from it); null if unknown. */
    age: z.number().int().min(0).max(110).nullable(),
    /** MM-DD of the birthday. */
    birthday: z
      .string()
      .regex(/^\d{2}-\d{2}$/)
      .default("06-15"),
    gender: z.enum(GENDERS).nullable().default(null),
    /** account: signs in; none: no login and no email (children); invited: only an invitation exists. */
    login: z.enum(["account", "none", "invited"]),
    email: testEmail.nullable().default(null),
    locale: z.string().nullable().default(null),
    phone: z.string().nullable().default(null),
    address: PostalAddressSchema.nullable().default(null),
    protectedIdentity: z.boolean().default(false),
    /** Children: the guardian who created them (`Add child`). */
    createdBy: key.nullable().default(null),
    createdAt: RelativeTimeSchema.default("now"),
    description: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })
  .refine((p) => (p.login === "none" ? p.email === null : p.email !== null), {
    message: "people without login have no email; others need one",
  });
export type DemoPersona = z.infer<typeof DemoPersonaSchema>;

export const DemoPersonasFileSchema = z.object({ personas: z.array(DemoPersonaSchema) });

export const DemoGeneratedSchema = z.object({
  count: z.number().int().min(0),
  /** Ages of the generated members (children are born in the group's birth year). */
  ageFrom: z.number().int().min(0),
  ageTo: z.number().int().min(0),
  gender: z.enum(GENDERS).nullable().default(null),
  /** How many of them get the club-level protected identity flag, set by `protectedBy`. */
  clubProtected: z.number().int().min(0).default(0),
  protectedBy: key.nullable().default(null),
});

export const DemoGroupSchema = z.object({
  key,
  id: z.uuid(),
  club: key,
  /** "{year}" is replaced by the birth year (birthYearAgo years before the year of seeding). */
  name: z.string().min(1),
  kind: z.enum(GROUP_KINDS),
  parent: key.nullable().default(null),
  birthYearAgo: z.number().int().min(0).nullable().default(null),
  genderCategory: z.enum(GENDER_CATEGORIES).nullable().default(null),
  sport: z.string().nullable().default(null),
  capacity: z.number().int().min(0).nullable().default(null),
  admissionMode: z.enum(ADMISSION_MODES).default("direct"),
  owners: z.array(key).default([]),
  generated: DemoGeneratedSchema.nullable().default(null),
});
export type DemoGroup = z.infer<typeof DemoGroupSchema>;

export const DemoClubSchema = z.object({
  key,
  id: z.uuid(),
  name: z.string().min(2),
  shortName: z.string().min(1),
  slug: z.string(),
  country: z.string().regex(/^[A-Z]{2}$/),
  joinPolicy: z.enum(JOIN_POLICIES),
  foundedBy: key,
  foundedAt: RelativeTimeSchema,
  /** Who acts for the club when the data does not say (a current manager). */
  actor: key,
});
export type DemoClub = z.infer<typeof DemoClubSchema>;

export const DemoClubsFileSchema = z.object({
  clubs: z.array(DemoClubSchema),
  groups: z.array(DemoGroupSchema),
});

const since = RelativeTimeSchema.nullable().default(null);

export const DemoRelationshipsFileSchema = z.object({
  /** In order: the first guardian of a child is its createdBy (Add child). */
  guardianships: z.array(
    z.object({
      guardian: key,
      ward: key,
      kind: z.enum(GUARDIANSHIP_KINDS),
      /** addGuardian (by a full guardian), or an e-mail invitation accepted or still pending. */
      via: z.enum(["addChild", "addGuardian", "invitation"]),
      by: key.nullable().default(null),
      status: z.enum(["active", "pending"]).default("active"),
      rights: z.array(z.enum(GUARDIANSHIP_RIGHTS)).nullable().default(null),
    }),
  ),
  memberships: z.array(
    z.object({
      person: key,
      club: key,
      membershipType: z.enum(MEMBERSHIP_TYPES).default("active"),
      /** active (added by `by`, default the club's actor), applied (join request pending), left. */
      /** Applications are join requests (joinRequests below), not memberships (P1.1). */
      status: z.enum(["active", "left"]).default("active"),
      by: key.nullable().default(null),
      since,
      until: since,
    }),
  ),
  roles: z.array(
    z.object({
      person: key,
      club: key,
      role: z.enum(CLUB_ROLES),
      by: key.nullable().default(null),
      since,
      until: since,
    }),
  ),
  groupMemberships: z.array(
    z.object({
      person: key,
      group: key,
      function: z.enum(GROUP_FUNCTIONS).default("member"),
      by: key.nullable().default(null),
      since,
    }),
  ),
  handovers: z.array(
    z.object({
      club: key,
      from: key,
      to: key,
      status: z.enum(["proposed", "accepted"]),
      at: RelativeTimeSchema,
    }),
  ),
  /** "Give own login": the guardian invites the child's address, the child accepts. */
  ownLogins: z.array(z.object({ person: key, by: key, at: RelativeTimeSchema })),
  employments: z.array(
    z.object({
      person: key,
      club: key,
      title: z.string(),
      employmentType: z.enum(EMPLOYMENT_TYPES),
      hoursPerWeek: z.number().nullable().default(null),
      startsOn: RelativeTimeSchema,
    }),
  ),
  consents: z.array(
    z.object({
      person: key,
      club: key,
      purpose: z.enum(CONSENT_PURPOSES),
      givenBy: key,
    }),
  ),
  sharedFields: z.array(
    z.object({ person: key, club: key, fields: z.array(z.enum(SHAREABLE_PERSON_FIELDS)) }),
  ),
  clubProtection: z.array(z.object({ person: key, club: key, by: key })),
  joinRequests: z.array(
    z.object({
      person: key,
      club: key,
      requestedBy: key,
      preferredGroups: z.array(key).default([]),
    }),
  ),
  /** Club invitations (flows in P1.1): rows only. */
  invitations: z.array(
    z.object({
      club: key,
      email: testEmail,
      createdBy: key,
      group: key.nullable().default(null),
      expiresIn: RelativeTimeSchema,
    }),
  ),
  operators: z.array(key),
  supportGrants: z.array(
    z.object({
      operator: key,
      club: key,
      grantedBy: key,
      reason: z.string(),
      expiresIn: RelativeTimeSchema,
    }),
  ),
});
export type DemoRelationships = z.infer<typeof DemoRelationshipsFileSchema>;

/** A waiting-list applicant: a named persona, or a generated child (with a generated guardian). */
export const DemoWaitlistsFileSchema = z.object({
  entries: z.array(
    z.object({
      group: key,
      person: key.nullable().default(null),
      requestedBy: key.nullable().default(null),
      status: z.enum(WAITLIST_STATUSES),
      queuedAt: RelativeTimeSchema,
      priority: z.number().int().default(0),
      offerExpiresIn: RelativeTimeSchema.nullable().default(null),
      outOfOrderReason: z.string().nullable().default(null),
      decidedBy: key.nullable().default(null),
      /** Admitted: the generated member of the group (by index) this entry admitted. */
      admittedMember: z.number().int().min(0).nullable().default(null),
    }),
  ),
});

/** Changes replayed with past times, so the History panel has content. */
export const DemoHistoryFileSchema = z.object({
  changes: z.array(
    z.discriminatedUnion("action", [
      z.object({
        action: z.literal("group.move"),
        at: RelativeTimeSchema,
        actor: key,
        person: key,
        from: key,
        to: key,
      }),
      z.object({
        action: z.literal("person.update"),
        at: RelativeTimeSchema,
        actor: key,
        person: key,
        phone: z.string(),
      }),
      z.object({
        action: z.literal("membership.approve"),
        at: RelativeTimeSchema,
        actor: key,
        person: key,
        club: key,
        appliedAt: RelativeTimeSchema,
      }),
      z.object({
        action: z.literal("waitlist.offer.expire"),
        at: RelativeTimeSchema,
        job: z.string(),
        group: key,
      }),
    ]),
  ),
});
export type DemoHistory = z.infer<typeof DemoHistoryFileSchema>;
