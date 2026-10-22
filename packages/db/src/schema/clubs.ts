// SPDX-License-Identifier: AGPL-3.0-only
// Clubs and what a person is in a club. Every table except `clubs` itself has
// club_id with tenant RLS; `clubs` is isolated on its id (migration 0001).

import {
  CLUB_ACCESS_STATES,
  CLUB_ROLES,
  CLUB_STATUSES,
  type ClubAccessState,
  type ClubRole,
  type ClubStatus,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  EMPLOYMENT_TYPES,
  type EmploymentType,
  HANDOVER_STATUSES,
  type HandoverStatus,
  JOIN_POLICIES,
  type JoinPolicy,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_TYPES,
  type MembershipStatus,
  type MembershipType,
  SHAREABLE_PERSON_FIELDS,
  type ShareablePersonField,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, oneOf, subsetOf, timestamps, tz, validity, validPeriod } from "./columns.ts";
import { people, type PostalAddress } from "./people.ts";

export const clubs = pgTable(
  "clubs",
  {
    id: id(),
    name: text().notNull(),
    shortName: text(),
    /** URL name for public pages, unique system-wide. */
    slug: text().notNull(),
    /** ISO 3166-1 alpha-2; selects the country pack. */
    country: text().notNull(),
    defaultLocale: text().notNull(),
    /** IANA time zone. */
    timeZone: text().notNull(),
    /** ISO 4217. */
    currency: text().notNull(),
    organizationNumber: text(),
    federationIds: jsonb().$type<Record<string, string>>().notNull().default({}),
    address: jsonb().$type<PostalAddress>(),
    /** Object storage key of the logo. */
    logo: text(),
    status: text().$type<ClubStatus>().notNull().default("active"),
    /** Whether the club can change its data (P0.12): read_only and suspended never delete anything. */
    accessState: text().$type<ClubAccessState>().notNull().default("active"),
    joinPolicy: text().$type<JoinPolicy>().notNull().default("approval"),
    /** Next club_profiles.member_number; taken under a row lock. */
    nextMemberNumber: integer().notNull().default(1),
    /** Group owners may appoint co-owners (default: only club managers). */
    ownersCanAppointCoOwners: boolean().notNull().default(false),
    /** Admitting from a waiting list also creates the club membership. */
    groupOwnersAdmitToClub: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("clubs_slug_unique").on(t.slug),
    check("clubs_status", oneOf(t.status, CLUB_STATUSES)),
    check("clubs_access_state", oneOf(t.accessState, CLUB_ACCESS_STATES)),
    check("clubs_join_policy", oneOf(t.joinPolicy, JOIN_POLICIES)),
    check("clubs_country", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check("clubs_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("clubs_slug_shape", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("clubs_next_member_number", sql`${t.nextMemberNumber} > 0`),
  ],
);

export const clubRef = () =>
  uuid()
    .notNull()
    .references(() => clubs.id);
export const personRef = () =>
  uuid()
    .notNull()
    .references(() => people.id);

/** What a club sees about a person (domain-model.md). Created with the first membership. */
export const clubProfiles = pgTable(
  "club_profiles",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    /**
     * Running number per club (ADR 0020). Leave unset: the assign_member_number
     * trigger takes it from clubs.next_member_number under the club row's lock.
     */
    memberNumber: integer()
      .notNull()
      .default(sql`NULL`),
    /** Which of the person's own fields this club may see. */
    sharedFields: text().array().$type<ShareablePersonField[]>().notNull().default([]),
    emergencyContacts: jsonb()
      .$type<{ name: string; phone: string; relation?: string | undefined }[]>()
      .notNull()
      .default([]),
    /** Restricted notes (club managers and registrars, P0.7). */
    notes: text(),
    /** Club-level protected identity (ADR 0022), set by a club manager. */
    protectedIdentityClub: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique("club_profiles_person_unique").on(t.clubId, t.personId),
    unique("club_profiles_member_number_unique").on(t.clubId, t.memberNumber),
    index("club_profiles_person_idx").on(t.personId),
    index("club_profiles_protected_idx")
      .on(t.clubId)
      .where(sql`${t.protectedIdentityClub}`),
    check("club_profiles_shared_fields", subsetOf(t.sharedFields, SHAREABLE_PERSON_FIELDS)),
    check("club_profiles_member_number", sql`${t.memberNumber} > 0`),
  ],
);

export const clubMemberships = pgTable(
  "club_memberships",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    status: text().$type<MembershipStatus>().notNull(),
    membershipType: text().$type<MembershipType>().notNull().default("active"),
    ...validity,
    ...timestamps,
  },
  (t) => [
    check("club_memberships_status", oneOf(t.status, MEMBERSHIP_STATUSES)),
    check("club_memberships_type", oneOf(t.membershipType, MEMBERSHIP_TYPES)),
    check("club_memberships_valid_period", validPeriod(t.validFrom, t.validTo)),
    check(
      "club_memberships_left_has_valid_to",
      sql`(${t.status} = 'left') = (${t.validTo} IS NOT NULL)`,
    ),
    uniqueIndex("club_memberships_open_unique")
      .on(t.clubId, t.personId)
      .where(sql`${t.validTo} IS NULL`),
    index("club_memberships_club_person_idx").on(t.clubId, t.personId),
    index("club_memberships_person_active_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

export const clubRoleAssignments = pgTable(
  "club_role_assignments",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    role: text().$type<ClubRole>().notNull(),
    assignedByPersonId: uuid().references(() => people.id),
    endedByPersonId: uuid().references(() => people.id),
    ...validity,
    ...timestamps,
  },
  (t) => [
    check("club_role_assignments_role", oneOf(t.role, CLUB_ROLES)),
    check("club_role_assignments_valid_period", validPeriod(t.validFrom, t.validTo)),
    uniqueIndex("club_role_assignments_open_unique")
      .on(t.clubId, t.personId, t.role)
      .where(sql`${t.validTo} IS NULL`),
    index("club_role_assignments_club_role_idx")
      .on(t.clubId, t.role)
      .where(sql`${t.validTo} IS NULL`),
    index("club_role_assignments_person_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

/** Manager hand-over (ADR 0018): the successor accepts, then the proposer steps down. */
export const clubManagerHandovers = pgTable(
  "club_manager_handovers",
  {
    id: id(),
    clubId: clubRef(),
    fromPersonId: personRef(),
    toPersonId: personRef(),
    status: text().$type<HandoverStatus>().notNull().default("proposed"),
    expiresAt: timestamp(tz).notNull(),
    decidedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    check("club_manager_handovers_status", oneOf(t.status, HANDOVER_STATUSES)),
    check("club_manager_handovers_not_self", sql`${t.fromPersonId} <> ${t.toPersonId}`),
    uniqueIndex("club_manager_handovers_open_unique")
      .on(t.clubId, t.fromPersonId)
      .where(sql`${t.status} = 'proposed'`),
    index("club_manager_handovers_to_idx")
      .on(t.toPersonId)
      .where(sql`${t.status} = 'proposed'`),
  ],
);

export const employments = pgTable(
  "employments",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    title: text().notNull(),
    employmentType: text().$type<EmploymentType>().notNull(),
    startsOn: date({ mode: "string" }).notNull(),
    endsOn: date({ mode: "string" }),
    hoursPerWeek: numeric({ precision: 5, scale: 2 }),
    ...timestamps,
  },
  (t) => [
    check("employments_type", oneOf(t.employmentType, EMPLOYMENT_TYPES)),
    check("employments_period", sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    index("employments_club_person_idx").on(t.clubId, t.personId),
    index("employments_person_idx").on(t.personId),
  ],
);

export const consents = pgTable(
  "consents",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    purpose: text().$type<ConsentPurpose>().notNull(),
    /** Version of the consent text the person agreed to. */
    textVersion: text().notNull(),
    /** The person, or a guardian for a child under the consent age. */
    givenByPersonId: personRef(),
    givenAt: timestamp(tz).notNull().defaultNow(),
    revokedAt: timestamp(tz),
    revokedByPersonId: uuid().references(() => people.id),
    ...timestamps,
  },
  (t) => [
    check("consents_purpose", oneOf(t.purpose, CONSENT_PURPOSES)),
    uniqueIndex("consents_open_unique")
      .on(t.clubId, t.personId, t.purpose)
      .where(sql`${t.revokedAt} IS NULL`),
    index("consents_person_idx").on(t.personId),
  ],
);
