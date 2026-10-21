// SPDX-License-Identifier: AGPL-3.0-only
// Getting into a club or group: waiting lists (ADR 0019), join requests and
// invitations (ADR 0018). Schema only in P0.5, so later packages have stable
// names; the flows come in P1.1 (joining) and P1.10 (waiting lists).

import {
  CLUB_ROLES,
  type ClubRole,
  INVITATION_KINDS,
  type InvitationKind,
  JOIN_REQUEST_STATUSES,
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

/** Schema only in P0.5; the flow comes in P1.1. */
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
    decidedAt: timestamp(tz),
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

/** Schema only in P0.5; the flow comes in P1.1. */
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
