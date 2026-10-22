// SPDX-License-Identifier: AGPL-3.0-only
// Getting into a club or group: waiting lists (ADR 0019), join requests and
// invitations (ADR 0018), and requests to create a club (CLUB_CREATION=approval).
// Waiting lists are schema only until P1.10.

import {
  CLUB_CREATION_REQUEST_STATUSES,
  CLUB_ROLES,
  type ClubCreationRequestStatus,
  type ClubRole,
  INVITATION_KINDS,
  type InvitationKind,
  JOIN_POLICIES,
  JOIN_REQUEST_STATUSES,
  type JoinPolicy,
  type JoinRequestStatus,
  WAITLIST_STATUSES,
  type WaitlistStatus,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { clubRef, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";
import { people } from "./people.ts";

export const groupWaitlistEntries = pgTable(
  "group_waitlist_entries",
  {
    id: id(),
    clubId: clubRef(),
    groupId: uuid().notNull(),
    personId: personRef(),
    /** E.g. a guardian applying for a child. */
    requestedByPersonId: personRef(),
    status: text().$type<WaitlistStatus>().notNull().default("waiting"),
    queuedAt: timestamp(tz).notNull().defaultNow(),
    /** Higher first (e.g. sibling, returning member). */
    priority: smallint().notNull().default(0),
    offerExpiresAt: timestamp(tz),
    applicantNote: text(),
    /** Visible to group owners only. */
    ownerNote: text(),
    /** Required when admitting out of order (audited). */
    outOfOrderReason: text(),
    decidedByPersonId: uuid().references(() => people.id),
    decidedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "group_waitlist_entries_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    check("group_waitlist_entries_status", oneOf(t.status, WAITLIST_STATUSES)),
    check(
      "group_waitlist_entries_offer",
      sql`(${t.status} = 'offered') <= (${t.offerExpiresAt} IS NOT NULL)`,
    ),
    uniqueIndex("group_waitlist_entries_open_unique")
      .on(t.groupId, t.personId)
      .where(sql`${t.status} IN ('waiting', 'offered')`),
    // Waiting-list order (ADR 0019).
    index("group_waitlist_entries_order_idx").on(
      t.groupId,
      t.status,
      t.priority.desc(),
      t.queuedAt,
    ),
    index("group_waitlist_entries_person_idx").on(t.personId),
  ],
);

/**
 * A person (or a guardian for a ward) asking to join a club with
 * join_policy = approval (ADR 0018). The only record of an application:
 * approving creates the active membership (P1.1).
 */
export const joinRequests = pgTable(
  "join_requests",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    /** The person themselves, or a guardian applying for a child. */
    requestedByPersonId: personRef(),
    status: text().$type<JoinRequestStatus>().notNull().default("pending"),
    message: text(),
    /** Group preferences as a hint for the club. */
    preferredGroupIds: uuid().array().notNull().default([]),
    decidedByPersonId: uuid().references(() => people.id),
    /** Set when approved, rejected or withdrawn. */
    decidedAt: timestamp(tz),
    /** The club's message to the applicant with the decision. */
    decisionMessage: text(),
    ...timestamps,
  },
  (t) => [
    check("join_requests_status", oneOf(t.status, JOIN_REQUEST_STATUSES)),
    uniqueIndex("join_requests_pending_unique")
      .on(t.clubId, t.personId)
      .where(sql`${t.status} = 'pending'`),
    index("join_requests_club_status_idx").on(t.clubId, t.status, t.createdAt),
    index("join_requests_person_idx").on(t.personId),
  ],
);

/**
 * Email, link or code invitations to a club, with optional group and role
 * presets (ADR 0018). Only a hash of the secret is stored: link tokens and
 * codes are random and shown once; email tokens are derived from the ID
 * (HMAC, ADR 0032) so the worker can put them in the email.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    clubId: clubRef(),
    kind: text().$type<InvitationKind>().notNull(),
    /** For email invitations (normalised). */
    email: text(),
    /** SHA-256 of the secret token (link) or code. */
    tokenHash: text().notNull(),
    /** Presets applied on acceptance. */
    rolePreset: text().$type<ClubRole>(),
    groupId: uuid(),
    expiresAt: timestamp(tz).notNull(),
    maxUses: integer(),
    uses: integer().notNull().default(0),
    createdByPersonId: personRef(),
    acceptedByPersonId: uuid().references(() => people.id),
    acceptedAt: timestamp(tz),
    revokedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    check("invitations_kind", oneOf(t.kind, INVITATION_KINDS)),
    check("invitations_email", sql`(${t.kind} = 'email') = (${t.email} IS NOT NULL)`),
    check(
      "invitations_role_preset",
      sql`${t.rolePreset} IS NULL OR ${oneOf(t.rolePreset, CLUB_ROLES)}`,
    ),
    foreignKey({
      name: "invitations_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    uniqueIndex("invitations_token_unique").on(t.tokenHash),
    index("invitations_club_idx").on(t.clubId, t.createdAt),
  ],
);

/** Who accepted an invitation (a link or code can be used several times). */
export const invitationAcceptances = pgTable(
  "invitation_acceptances",
  {
    id: id(),
    clubId: clubRef(),
    invitationId: uuid()
      .notNull()
      .references(() => invitations.id),
    personId: personRef(),
    acceptedAt: timestamp(tz).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invitation_acceptances_unique").on(t.invitationId, t.personId),
    index("invitation_acceptances_person_idx").on(t.personId),
  ],
);

/**
 * A request to create a club (CLUB_CREATION=approval), decided by a platform
 * operator. Global (no club yet): visible to the requester and operators.
 */
export const clubCreationRequests = pgTable(
  "club_creation_requests",
  {
    id: id(),
    requestedByPersonId: personRef(),
    status: text().$type<ClubCreationRequestStatus>().notNull().default("pending"),
    name: text().notNull(),
    shortName: text(),
    slug: text().notNull(),
    country: text().notNull(),
    defaultLocale: text(),
    timeZone: text(),
    currency: text(),
    joinPolicy: text().$type<JoinPolicy>(),
    organizationNumber: text(),
    decidedByPersonId: uuid().references(() => people.id),
    decidedAt: timestamp(tz),
    decisionMessage: text(),
    /** The club created on approval (not club-owned: the request is global). */
    createdClubId: uuid(),
    ...timestamps,
  },
  (t) => [
    check("club_creation_requests_status", oneOf(t.status, CLUB_CREATION_REQUEST_STATUSES)),
    check(
      "club_creation_requests_join_policy",
      sql`${t.joinPolicy} IS NULL OR ${oneOf(t.joinPolicy, JOIN_POLICIES)}`,
    ),
    check(
      "club_creation_requests_club",
      sql`(${t.status} = 'approved') = (${t.createdClubId} IS NOT NULL)`,
    ),
    uniqueIndex("club_creation_requests_pending_unique")
      .on(t.requestedByPersonId)
      .where(sql`${t.status} = 'pending'`),
    index("club_creation_requests_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * A platform operator appointing a club manager on the club's documented
 * request (ADR 0018, recovery when no manager is left). The reason is kept
 * for the club's managers to read.
 */
export const clubManagerReassignments = pgTable(
  "club_manager_reassignments",
  {
    id: id(),
    clubId: clubRef(),
    personId: personRef(),
    operatorPersonId: personRef(),
    reason: text().notNull(),
    ...timestamps,
  },
  (t) => [index("club_manager_reassignments_club_idx").on(t.clubId, t.createdAt)],
);
