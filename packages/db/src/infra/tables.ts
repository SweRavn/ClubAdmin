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

export const cryptoSchema = pgSchema("crypto");
export const dataKeys = cryptoSchema.table("data_keys", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id"),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: timestamp("created_at", tz).notNull(),
  rewrappedAt: timestamp("rewrapped_at", tz),
  retiredAt: timestamp("retired_at", tz),
});

export const opsSchema = pgSchema("ops");
export const backupRuns = opsSchema.table("backup_runs", {
  id: uuid().primaryKey(),
  kind: text().$type<"full" | "diff" | "incr" | "monthly" | "files" | "ledger">().notNull(),
  status: text().$type<"running" | "succeeded" | "failed">().notNull(),
  startedAt: timestamp("started_at", tz).notNull(),
  finishedAt: timestamp("finished_at", tz),
  label: text(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  rowCounts: jsonb("row_counts").$type<Record<string, number>>(),
  error: text(),
});
export const restoreVerifications = opsSchema.table("restore_verifications", {
  id: uuid().primaryKey(),
  status: text().$type<"running" | "passed" | "failed">().notNull(),
  startedAt: timestamp("started_at", tz).notNull(),
  finishedAt: timestamp("finished_at", tz),
  targetTime: timestamp("target_time", tz),
  label: text(),
  checks: jsonb().$type<{ name: string; status: string; detail?: string }[]>().notNull(),
  initiatedBy: text("initiated_by").notNull(),
  durationMs: integer("duration_ms"),
});
