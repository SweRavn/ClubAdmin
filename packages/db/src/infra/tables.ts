// SPDX-License-Identifier: AGPL-3.0-only
// Drizzle definitions of the infrastructure tables for typed queries. The
// tables themselves are created by hand-written migrations
// (migrations/0000_foundation.sql), not by drizzle-kit.

import {
  bigint,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;

export const historySchema = pgSchema("history");
export const recordChanges = historySchema.table(
  "record_changes",
  {
    id: uuid().notNull(),
    changedAt: timestamp("changed_at", tz).notNull(),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id").notNull(),
    clubId: uuid("club_id"),
    operation: text().$type<"INSERT" | "UPDATE" | "DELETE">().notNull(),
    changedColumns: text("changed_columns").array().notNull(),
    oldValues: jsonb("old_values").$type<Record<string, unknown> | null>(),
    newValues: jsonb("new_values").$type<Record<string, unknown> | null>(),
    actorPersonId: uuid("actor_person_id"),
    onBehalfOfPersonId: uuid("on_behalf_of_person_id"),
    actorKind: text("actor_kind").notNull(),
    requestId: text("request_id"),
    transactionId: bigint("transaction_id", { mode: "number" }).notNull(),
    dbRole: text("db_role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.changedAt] })],
);

export const auditSchema = pgSchema("audit");
export const auditEvents = auditSchema.table("events", {
  id: uuid().primaryKey(),
  createdAt: timestamp("created_at", tz).notNull(),
  clubId: uuid("club_id"),
  actorPersonId: uuid("actor_person_id"),
  onBehalfOfPersonId: uuid("on_behalf_of_person_id"),
  actorKind: text("actor_kind").notNull(),
  action: text().notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id"),
  changedFields: text("changed_fields").array().notNull(),
  ipHash: text("ip_hash"),
  requestId: text("request_id"),
});

export const outboxSchema = pgSchema("outbox");
export const outboxEvents = outboxSchema.table("events", {
  id: uuid().primaryKey(),
  createdAt: timestamp("created_at", tz).notNull(),
  type: text().notNull(),
  clubId: uuid("club_id"),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text().$type<"pending" | "done" | "failed">().notNull(),
  attempts: integer().notNull(),
  dispatchedAt: timestamp("dispatched_at", tz),
  lastError: text("last_error"),
});
export const outboxDeliveries = outboxSchema.table(
  "deliveries",
  {
    eventId: uuid("event_id").notNull(),
    handler: text().notNull(),
    deliveredAt: timestamp("delivered_at", tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.handler] })],
);

export const privacySchema = pgSchema("privacy");
export const deletionLedger = privacySchema.table("deletion_ledger", {
  personId: uuid("person_id").primaryKey(),
  erasedAt: timestamp("erased_at", tz).notNull(),
  reason: text().notNull(),
});
