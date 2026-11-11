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
  CONSENT_REVOKED_REASONS,
  CONSENT_SOURCES,
  type ConsentPurpose,
  type ConsentRevokedReason,
  type ConsentSource,
  DECISION_BODIES,
  type DecisionBody,
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
  PROFILE_VIEW_LOGGING_MODES,
  type ProfileViewLoggingMode,
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
    /** The club's contact address (not a login; P1.6b). */
    email: text(),
    federationIds: jsonb().$type<Record<string, string>>().notNull().default({}),
    address: jsonb().$type<PostalAddress>(),
    /** Object storage key of the logo. */
    logo: text(),
    status: text().$type<ClubStatus>().notNull().default("active"),
    /** Whether the club can change its data (P0.12): read_only and suspended never delete anything. */
    accessState: text().$type<ClubAccessState>().notNull().default("active"),
    /** Who restricted the club (P1.13): an operator, or billing; a payment lifts only billing's. */
    accessStateSource: text().$type<"operator" | "billing">(),
    joinPolicy: text().$type<JoinPolicy>().notNull().default("approval"),
    /** Next club_profiles.member_number; taken under a row lock. */
    nextMemberNumber: integer().notNull().default(1),
    /** Group owners may appoint co-owners (default: only club managers). */
    ownersCanAppointCoOwners: boolean().notNull().default(false),
    /** Admitting from a waiting list also creates the club membership. */
    groupOwnersAdmitToClub: boolean().notNull().default(true),
    /** Days after an activity during which its leaders record attendance (P1.5). */
    attendanceLockDays: integer().notNull().default(30),
    /** Months after an activity that its answers and attendance are kept (at least 12; #18). */
    attendanceRetentionMonths: integer().notNull().default(12),
    /** The consents the club asks for (P1.8a; a board setting). */
    consentPurposes: text()
      .array()
      .$type<ConsentPurpose[]>()
      .notNull()
      .default(sql`'{photo_publication,video_publication}'::text[]`),
    /** A new consent text version revokes open consents of older versions (P1.8a). */
    consentReconfirmOnNewVersion: boolean().notNull().default(false),
    /** Months after the last membership ended that a former member's profile is kept (P1.8a). */
    formerMemberRetentionMonths: integer().notNull().default(24),
    /** Where members send privacy questions (a function address; P1.8a). */
    privacyContactEmail: text(),
    /** Which profile views the club logs (P1.12): protected people only, or every view. */
    profileViewLogging: text().$type<ProfileViewLoggingMode>().notNull().default("protected_only"),
    /** Until when a club with fewer than two administrators may still add members (P1.15 A3). */
    administratorsGraceUntil: timestamp(tz),
    /** When an operator extended the grace period (once per club). */
    administratorsGraceExtendedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("clubs_slug_unique").on(t.slug),
    check("clubs_status", oneOf(t.status, CLUB_STATUSES)),
    check("clubs_access_state", oneOf(t.accessState, CLUB_ACCESS_STATES)),
    check("clubs_access_state_source", oneOf(t.accessStateSource, ["operator", "billing"])),
    check("clubs_join_policy", oneOf(t.joinPolicy, JOIN_POLICIES)),
    check("clubs_attendance_lock_days", sql`${t.attendanceLockDays} BETWEEN 1 AND 365`),
    check(
      "clubs_attendance_retention_months",
      sql`${t.attendanceRetentionMonths} BETWEEN 12 AND 120`,
    ),
    check("clubs_consent_purposes", subsetOf(t.consentPurposes, CONSENT_PURPOSES)),
    check(
      "clubs_former_member_retention_months",
      sql`${t.formerMemberRetentionMonths} BETWEEN 6 AND 120`,
    ),
    check(
      "clubs_privacy_contact_email",
      sql`${t.privacyContactEmail} IS NULL OR (length(${t.privacyContactEmail}) <= 254 AND ${t.privacyContactEmail} ~ '^[^@\\s]+@[^@\\s]+$')`,
    ),
    check("clubs_profile_view_logging", oneOf(t.profileViewLogging, PROFILE_VIEW_LOGGING_MODES)),
    check("clubs_country", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check("clubs_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("clubs_slug_shape", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("clubs_next_member_number", sql`${t.nextMemberNumber} > 0`),
    check(
      "clubs_email",
      sql`${t.email} IS NULL OR (length(${t.email}) <= 254 AND ${t.email} ~ '^[^@\\s]+@[^@\\s]+$')`,
    ),
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

/** The club's phone numbers (P1.6b): the office, the chair, … in the order shown. */
export const clubPhoneNumbers = pgTable(
  "club_phone_numbers",
  {
    id: id(),
    clubId: clubRef(),
    /** "Kansli", "Ordförande". */
    label: text().notNull(),
    number: text().notNull(),
    sortOrder: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    index("club_phone_numbers_club_idx").on(t.clubId, t.sortOrder),
    check("club_phone_numbers_label", sql`length(${t.label}) BETWEEN 1 AND 60`),
    check("club_phone_numbers_number", sql`length(${t.number}) BETWEEN 3 AND 40`),
  ],
);

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
    /** Who set the club flag, and when (P1.12; shown to club managers). Cleared when off. */
    protectedIdentityClubSetByPersonId: uuid().references(() => people.id),
    protectedIdentityClubSetAt: timestamp(tz),
    /** The former-member purge ran for this person and club (P1.8a). */
    clubDataPurgedAt: timestamp(tz),
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
    // The member register (P1.2): filters by status and type, "joined" sorting.
    index("club_memberships_register_idx").on(t.clubId, t.status, t.membershipType),
    index("club_memberships_joined_idx").on(t.clubId, t.validFrom, t.id),
    index("club_memberships_person_active_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
    // Former members past the club's retention period (P1.8a).
    index("club_memberships_left_idx")
      .on(t.clubId, t.validTo)
      .where(sql`${t.status} = 'left'`),
  ],
);

export const clubRoleAssignments = pgTable(
  "club_role_assignments",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    role: text().$type<ClubRole>().notNull(),
    /** The club's role (P1.15; filled from `role` by a trigger for older writers). */
    roleId: uuid(), // NOT NULL in the database (0032); filled by a trigger for writers naming the template key
    assignedByPersonId: uuid().references(() => people.id),
    endedByPersonId: uuid().references(() => people.id),
    ...validity,
    ...timestamps,
  },
  (t) => [
    check("club_role_assignments_role", oneOf(t.role, CLUB_ROLES)),
    check("club_role_assignments_valid_period", validPeriod(t.validFrom, t.validTo)),
    uniqueIndex("club_role_assignments_open_unique")
      .on(t.clubId, t.personId, t.roleId)
      .where(sql`${t.validTo} IS NULL`),
    index("club_role_assignments_club_role_idx")
      .on(t.clubId, t.role)
      .where(sql`${t.validTo} IS NULL`),
    index("club_role_assignments_person_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
    index("club_role_assignments_role_idx")
      .on(t.clubId, t.roleId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

/**
 * A club's roles (P1.15, ADR 0046): named sets of permissions, held in the
 * club or in a group. Template roles keep their `template_key`; names and
 * descriptions fall back to the catalogue's texts while NULL.
 */
export const roles = pgTable(
  "roles",
  {
    id: id(),
    clubId: clubRef(),
    scope: text().$type<"club" | "group">().notNull(),
    templateKey: text(),
    locked: boolean().notNull().default(false),
    names: jsonb().$type<Partial<Record<string, string>>>(),
    descriptions: jsonb().$type<Partial<Record<string, string>>>(),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp(tz),
    version: integer().notNull().default(1),
    ...timestamps,
  },
  (t) => [
    check("roles_scope", sql`${t.scope} IN ('club', 'group')`),
    unique("roles_club_id_unique").on(t.clubId, t.id),
    uniqueIndex("roles_template_unique")
      .on(t.clubId, t.scope, t.templateKey)
      .where(sql`${t.templateKey} IS NOT NULL`),
  ],
);

/** The permissions of a role (catalogue keys, @clubadmin/shared ROLE_PERMISSIONS). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: id(),
    clubId: uuid().notNull(),
    roleId: uuid().notNull(),
    permission: text().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("role_permissions_unique").on(t.roleId, t.permission),
    index("role_permissions_club_permission_idx").on(t.clubId, t.permission),
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

/** The two-person rule for taking an administrator out (P1.15 A3, ADR 0046). */
export const administratorSuspensions = pgTable(
  "administrator_suspensions",
  {
    id: id(),
    clubId: clubRef(),
    targetPersonId: personRef(),
    requestedByPersonId: personRef(),
    confirmedByPersonId: uuid().references(() => people.id),
    reason: text().$type<"compromised" | "left_task" | "other">().notNull(),
    note: text(),
    demote: boolean().notNull().default(false),
    status: text()
      .$type<"requested" | "confirmed" | "cancelled" | "expired">()
      .notNull()
      .default("requested"),
    expiresAt: timestamp(tz).notNull(),
    decidedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    check(
      "administrator_suspensions_reason",
      sql`${t.reason} IN ('compromised', 'left_task', 'other')`,
    ),
    check(
      "administrator_suspensions_status",
      sql`${t.status} IN ('requested', 'confirmed', 'cancelled', 'expired')`,
    ),
    uniqueIndex("administrator_suspensions_open_unique")
      .on(t.clubId, t.targetPersonId)
      .where(sql`${t.status} = 'requested'`),
    index("administrator_suspensions_club_idx").on(t.clubId, t.createdAt.desc()),
    index("administrator_suspensions_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'requested'`),
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
    /** Who gave it: the person, a guardian, or the club recording a paper form (P1.8a). */
    source: text().$type<ConsentSource>().notNull().default("self"),
    /** The club's note on a recorded consent ("paper form 2026-08-14"); never in audit events. */
    clubNote: text(),
    revokedReason: text().$type<ConsentRevokedReason>(),
    ...timestamps,
  },
  (t) => [
    check("consents_purpose", oneOf(t.purpose, CONSENT_PURPOSES)),
    check("consents_source", oneOf(t.source, CONSENT_SOURCES)),
    check(
      "consents_revoked_reason",
      sql`${t.revokedReason} IS NULL OR ${oneOf(t.revokedReason, CONSENT_REVOKED_REASONS)}`,
    ),
    check(
      "consents_club_note",
      sql`${t.clubNote} IS NULL OR (${t.source} = 'club_record' AND length(${t.clubNote}) <= 500)`,
    ),
    check("consents_text_version", sql`${t.textVersion} ~ '^(default|club):[1-9][0-9]*$'`),
    uniqueIndex("consents_open_unique")
      .on(t.clubId, t.personId, t.purpose)
      .where(sql`${t.revokedAt} IS NULL`),
    index("consents_person_idx").on(t.personId),
    // Group overviews and field visibility: who in the club has an open consent (P1.8a).
    index("consents_club_purpose_idx")
      .on(t.clubId, t.purpose, t.personId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/** A club's own text for a consent purpose (P1.8a); immutable versions. */
export const consentTexts = pgTable(
  "consent_texts",
  {
    id: id(),
    clubId: clubRef(),
    purpose: text().$type<ConsentPurpose>().notNull(),
    version: integer().notNull(),
    /** { sv?, en?, nb? }: at least the club's default language. */
    texts: jsonb().$type<Partial<Record<"sv" | "en" | "nb", string>>>().notNull(),
    publishedByPersonId: personRef(),
    publishedAt: timestamp(tz).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    check("consent_texts_purpose", oneOf(t.purpose, CONSENT_PURPOSES)),
    check("consent_texts_version", sql`${t.version} > 0`),
    unique("consent_texts_version_unique").on(t.clubId, t.purpose, t.version),
  ],
);

/** A recorded decision by a club's board or meeting on its settings (P1.8a, ADR 0037). */
export const clubSettingDecisions = pgTable(
  "club_setting_decisions",
  {
    id: id(),
    clubId: clubRef(),
    body: text().$type<DecisionBody>().notNull(),
    decidedOn: date({ mode: "string" }).notNull(),
    /** The minutes' paragraph ("§ 7"). */
    reference: text().notNull(),
    effectiveFrom: date({ mode: "string" }).notNull(),
    /** Registry key → value; only settings the board decides. */
    settings: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Set when the values were written to the club (at once, or by clubs:apply_decisions). */
    appliedAt: timestamp(tz),
    recordedByPersonId: personRef(),
    recordedAt: timestamp(tz).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    check("club_setting_decisions_body", oneOf(t.body, DECISION_BODIES)),
    check("club_setting_decisions_reference", sql`length(${t.reference}) BETWEEN 1 AND 200`),
    check("club_setting_decisions_effective", sql`${t.effectiveFrom} >= ${t.decidedOn}`),
    index("club_setting_decisions_club_idx").on(t.clubId, t.effectiveFrom.desc(), t.id.desc()),
    index("club_setting_decisions_pending_idx")
      .on(t.effectiveFrom)
      .where(sql`${t.appliedAt} IS NULL`),
  ],
);

/** Each published version of a club's privacy policy (P1.8a). */
export const clubPrivacyPolicies = pgTable(
  "club_privacy_policies",
  {
    id: id(),
    clubId: clubRef(),
    version: integer().notNull(),
    /** The country pack's template version. */
    templateVersion: integer().notNull(),
    /** Snapshot of the values the policy shows (registry key → value, purposes asked). */
    settings: jsonb().$type<Record<string, unknown>>().notNull(),
    decisionId: uuid().references(() => clubSettingDecisions.id),
    effectiveFrom: date({ mode: "string" }).notNull(),
    ...timestamps,
  },
  (t) => [
    check("club_privacy_policies_version", sql`${t.version} > 0`),
    unique("club_privacy_policies_version_unique").on(t.clubId, t.version),
  ],
);
