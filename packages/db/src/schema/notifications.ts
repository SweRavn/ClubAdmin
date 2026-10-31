// SPDX-License-Identifier: AGPL-3.0-only
// Notifications (P1.7, ADR 0039): the recipient's inbox across clubs, the
// deliveries of each notice by email and push, and the phones that receive
// push. Recipient-owned global tables (ADR 0023): the inbox belongs to the
// person, not to a club; club_id is for display, retention and erasure.
// Only the worker writes notifications and deliveries (system context).

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  PUSH_PLATFORMS,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { clubs, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { accounts } from "./people.ts";

export const DELIVERY_STATUSES = ["queued", "held", "sent", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    recipientPersonId: personRef(),
    clubId: uuid().references(() => clubs.id),
    category: text().$type<NotificationCategory>().notNull(),
    type: text().notNull(),
    /** What it is about: activity, series, event, join_request, account, … */
    subjectType: text().notNull(),
    subjectId: uuid(),
    /** The people it is about (wards, a player); at most ten. */
    aboutPersonIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** IDs, enum values, counts, times and titles of activities or events; never people's names, notes or addresses. */
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** One notice per recipient and dedupe key (redelivered events create nothing). */
    dedupeKey: text().notNull(),
    readAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("notifications_dedupe_unique").on(t.recipientPersonId, t.dedupeKey),
    check("notifications_category", oneOf(t.category, NOTIFICATION_CATEGORIES)),
    check("notifications_about", sql`cardinality(${t.aboutPersonIds}) <= 10`),
    index("notifications_inbox_idx").on(t.recipientPersonId, t.id.desc()),
    index("notifications_unread_idx")
      .on(t.recipientPersonId)
      .where(sql`${t.readAt} IS NULL`),
    index("notifications_created_idx").on(t.createdAt),
    index("notifications_about_idx").using("gin", t.aboutPersonIds),
  ],
);

export const pushDevices = pgTable(
  "push_devices",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    /** sha256 of the token: the lookup; the token itself is sealed. */
    tokenHash: text().notNull(),
    tokenSealed: text().notNull(),
    provider: text().notNull().default("expo"),
    platform: text().notNull(),
    appVariant: text().notNull().default("production"),
    lastSeenAt: timestamp(tz).notNull().defaultNow(),
    disabledAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("push_devices_token_unique").on(t.tokenHash),
    check("push_devices_platform", oneOf(t.platform, PUSH_PLATFORMS)),
    check("push_devices_provider", oneOf(t.provider, ["expo"])),
    index("push_devices_account_idx").on(t.accountId),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: id(),
    notificationId: uuid()
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: text().$type<NotificationChannel>().notNull(),
    pushDeviceId: uuid().references(() => pushDevices.id, { onDelete: "set null" }),
    status: text().$type<DeliveryStatus>().notNull().default("queued"),
    /** preference, no_address, no_device, no_provider, quiet_obsolete, digest_obsolete, budget, … */
    skipReason: text(),
    /** Held for the recipient's daily email. */
    digest: boolean().notNull().default(false),
    attempts: integer().notNull().default(0),
    sendAfter: timestamp(tz).notNull().defaultNow(),
    sentAt: timestamp(tz),
    /** The provider's ID (Expo ticket, Message-ID). */
    providerRef: text(),
    /** A code, never provider text (it may contain addresses). */
    errorCode: text(),
    ...timestamps,
  },
  (t) => [
    check("notification_deliveries_channel", oneOf(t.channel, NOTIFICATION_CHANNELS)),
    check("notification_deliveries_status", oneOf(t.status, DELIVERY_STATUSES)),
    index("notification_deliveries_due_idx")
      .on(t.sendAfter)
      .where(sql`${t.status} IN ('queued', 'held')`),
    index("notification_deliveries_notification_idx").on(t.notificationId),
    index("notification_deliveries_receipts_idx")
      .on(t.sentAt)
      .where(sql`${t.channel} = 'push' AND ${t.status} = 'sent' AND ${t.providerRef} IS NOT NULL`),
  ],
);
