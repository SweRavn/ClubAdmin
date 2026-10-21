// SPDX-License-Identifier: AGPL-3.0-only
// Global tables (no club_id): a person exists once in the system
// (docs/domain-model.md). Row-level security restricts them to the person,
// their guardians and wards, and clubs the person belongs to (migration 0001).

import {
  GENDERS,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  GUARDIANSHIP_STATUSES,
  type GuardianshipKind,
  type GuardianshipRight,
  type GuardianshipStatus,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, oneOf, subsetOf, timestamps, tz } from "./columns.ts";

export interface PostalAddress {
  street: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export const people = pgTable(
  "people",
  {
    id: id(),
    givenName: text().notNull(),
    familyName: text().notNull(),
    /** Unknown for people who signed up themselves until they complete their profile (P1.1). */
    birthDate: date({ mode: "string" }),
    gender: text(),
    /** Ciphertext (envelope encryption, @clubadmin/server-kit/crypto). */
    personalIdentityNumber: text(),
    /** Keyed blind index of the normalised number, for finding duplicates. */
    personalIdentityNumberHash: text(),
    /** Global protected identity (ADR 0022), set by the person or a guardian. */
    protectedIdentity: boolean().notNull().default(false),
    phone: text(),
    address: jsonb().$type<PostalAddress>(),
    deceasedAt: timestamp(tz),
    anonymizedAt: timestamp(tz),
    /** Set when this person was merged into another (people_merges). */
    mergedIntoPersonId: uuid().references((): AnyPgColumn => people.id),
    createdByPersonId: uuid().references((): AnyPgColumn => people.id),
    ...timestamps,
  },
  (t) => [
    check("people_protected_no_address", sql`NOT ${t.protectedIdentity} OR ${t.address} IS NULL`),
    check("people_gender", sql`${t.gender} IS NULL OR ${oneOf(t.gender, GENDERS)}`),
    check(
      "people_pin_with_hash",
      sql`(${t.personalIdentityNumber} IS NULL) = (${t.personalIdentityNumberHash} IS NULL)`,
    ),
    check("people_not_merged_into_self", sql`${t.mergedIntoPersonId} <> ${t.id}`),
    index("people_pin_hash_idx")
      .on(t.personalIdentityNumberHash)
      .where(sql`${t.personalIdentityNumberHash} IS NOT NULL`),
    // Duplicate candidates: same birth date and family name.
    index("people_duplicate_idx").on(t.birthDate, sql`lower(${t.familyName})`),
    index("people_created_by_idx").on(t.createdByPersonId),
  ],
);

/** Login identity, at most one per person (ADR 0020). The only place an email is stored. */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => people.id),
    /** Stored normalised (trimmed, lower-case); unique case-insensitively. */
    email: text().notNull(),
    emailVerifiedAt: timestamp(tz).notNull(),
    /** Subject of the identity provider (Zitadel), set on first login (P0.6). */
    idpSubject: text(),
    locale: text(),
    timeZone: text(),
    theme: text(),
    notificationSettings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("accounts_person_unique").on(t.personId),
    uniqueIndex("accounts_email_unique").on(sql`lower(btrim(${t.email}))`),
    uniqueIndex("accounts_idp_subject_unique").on(t.idpSubject),
    check("accounts_email_normalised", sql`${t.email} = lower(btrim(${t.email}))`),
    check("accounts_email_shape", sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+$'`),
    check(
      "accounts_theme",
      sql`${t.theme} IS NULL OR ${oneOf(t.theme, ["light", "dark", "system"])}`,
    ),
  ],
);

export const guardianships = pgTable(
  "guardianships",
  {
    id: id(),
    guardianPersonId: uuid()
      .notNull()
      .references(() => people.id),
    wardPersonId: uuid()
      .notNull()
      .references(() => people.id),
    kind: text().$type<GuardianshipKind>().notNull(),
    rights: text().array().$type<GuardianshipRight[]>().notNull(),
    status: text().$type<GuardianshipStatus>().notNull().default("active"),
    validFrom: timestamp(tz).notNull().defaultNow(),
    validTo: timestamp(tz),
    createdByPersonId: uuid().references(() => people.id),
    /** Set by the worker when the ward reaches the country pack's adult age (not ended automatically). */
    wardAdultFlaggedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    check("guardianships_kind", oneOf(t.kind, GUARDIANSHIP_KINDS)),
    check("guardianships_rights", subsetOf(t.rights, GUARDIANSHIP_RIGHTS)),
    check("guardianships_status", oneOf(t.status, GUARDIANSHIP_STATUSES)),
    check("guardianships_not_self", sql`${t.guardianPersonId} <> ${t.wardPersonId}`),
    check("guardianships_valid_period", sql`${t.validTo} IS NULL OR ${t.validTo} > ${t.validFrom}`),
    check(
      "guardianships_ended_has_valid_to",
      sql`(${t.status} = 'ended') = (${t.validTo} IS NOT NULL)`,
    ),
    uniqueIndex("guardianships_open_unique")
      .on(t.guardianPersonId, t.wardPersonId)
      .where(sql`${t.validTo} IS NULL`),
    index("guardianships_guardian_idx")
      .on(t.guardianPersonId)
      .where(sql`${t.validTo} IS NULL`),
    index("guardianships_ward_idx")
      .on(t.wardPersonId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

/** A guardian invites a co-guardian by email; accepting creates the guardianship. */
export const guardianInvitations = pgTable(
  "guardian_invitations",
  {
    id: id(),
    wardPersonId: uuid()
      .notNull()
      .references(() => people.id),
    invitedByPersonId: uuid()
      .notNull()
      .references(() => people.id),
    /** Where the invitation is sent (normalised). Not linked to any person. */
    email: text().notNull(),
    /** SHA-256 of the secret token in the invitation link. */
    tokenHash: text().notNull(),
    kind: text().$type<GuardianshipKind>().notNull(),
    rights: text().array().$type<GuardianshipRight[]>().notNull(),
    expiresAt: timestamp(tz).notNull(),
    acceptedAt: timestamp(tz),
    acceptedByPersonId: uuid().references(() => people.id),
    guardianshipId: uuid().references(() => guardianships.id),
    revokedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("guardian_invitations_token_unique").on(t.tokenHash),
    index("guardian_invitations_ward_idx").on(t.wardPersonId),
    check("guardian_invitations_kind", oneOf(t.kind, GUARDIANSHIP_KINDS)),
    check("guardian_invitations_rights", subsetOf(t.rights, GUARDIANSHIP_RIGHTS)),
    check("guardian_invitations_email_normalised", sql`${t.email} = lower(btrim(${t.email}))`),
  ],
);

export interface MovedReference {
  table: string;
  id: string;
  clubId: string | null;
  column: string;
  /** "moved" to the kept person, or "ended" because the kept person already had the same relationship. */
  action: "moved" | "ended";
  /** Values of an ended row before the merge, restored on undo. */
  previous?: Record<string, unknown>;
}

/** Merged duplicates, kept for 30 days so a merge can be undone. */
export const peopleMerges = pgTable(
  "people_merges",
  {
    id: id(),
    keptPersonId: uuid()
      .notNull()
      .references(() => people.id),
    mergedPersonId: uuid()
      .notNull()
      .references(() => people.id),
    mergedByPersonId: uuid().references(() => people.id),
    undoUntil: timestamp(tz).notNull(),
    undoneAt: timestamp(tz),
    undoneByPersonId: uuid().references(() => people.id),
    movedReferences: jsonb().$type<MovedReference[]>().notNull(),
    ...timestamps,
  },
  (t) => [
    index("people_merges_kept_idx").on(t.keptPersonId),
    index("people_merges_merged_idx").on(t.mergedPersonId),
  ],
);

/**
 * "Give own login" (ADR 0020): an invitation to an account-less person's own
 * email. Completing sign-up with the token links the new account to the
 * person (P0.6); creating invitations in the UI comes in P1.3.
 */
export const accountInvitations = pgTable(
  "account_invitations",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => people.id),
    /** Normalised; the account must be created with this (verified) address. */
    email: text().notNull(),
    /** SHA-256 of the secret token in the invitation link. */
    tokenHash: text().notNull(),
    createdByPersonId: uuid()
      .notNull()
      .references(() => people.id),
    expiresAt: timestamp(tz).notNull(),
    acceptedAt: timestamp(tz),
    revokedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("account_invitations_token_unique").on(t.tokenHash),
    index("account_invitations_person_idx").on(t.personId),
    check("account_invitations_email_normalised", sql`${t.email} = lower(btrim(${t.email}))`),
  ],
);
