// SPDX-License-Identifier: AGPL-3.0-only
// Drizzle definitions of the infrastructure tables for typed queries. The
// tables themselves are created by hand-written migrations
// (migrations/0000_foundation.sql), not by drizzle-kit.

import {
  bigint,
  boolean,
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

// Billing (P0.12): created by migrations/0006 in every installation, used only
// by the billing module (BILLING_ENABLED=true) and its entitlements provider.
export const billingSchema = pgSchema("billing");
export const billingPlans = billingSchema.table("plans", {
  id: uuid().primaryKey(),
  key: text().notNull(),
  name: text().notNull(),
  kind: text().$type<"base" | "add_on">().notNull(),
  currency: text().notNull(),
  priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
  period: text().$type<"month" | "year">().notNull(),
  active: boolean().notNull(),
});
export const billingPlanEntitlements = billingSchema.table("plan_entitlements", {
  id: uuid().primaryKey(),
  planId: uuid("plan_id").notNull(),
  key: text().notNull(),
  kind: text().$type<"feature" | "limit">().notNull(),
  enabled: boolean(),
  limitValue: bigint("limit_value", { mode: "number" }),
});
export const billingPlanPrices = billingSchema.table("plan_prices", {
  id: uuid().primaryKey(),
  planId: uuid("plan_id").notNull(),
  currency: text().notNull(),
  period: text().$type<"month" | "year">().notNull(),
  priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
  active: boolean().notNull(),
});
export const billingSubscriptions = billingSchema.table("subscriptions", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id").notNull(),
  planId: uuid("plan_id").notNull(),
  addOnPlanIds: uuid("add_on_plan_ids").array().notNull(),
  status: text().$type<"trial" | "active" | "past_due" | "read_only" | "cancelled">().notNull(),
  trialEndsAt: timestamp("trial_ends_at", tz),
  currentPeriodStart: timestamp("current_period_start", tz),
  currentPeriodEnd: timestamp("current_period_end", tz),
  cancelledAt: timestamp("cancelled_at", tz),
  // P1.13
  billingPeriod: text("billing_period").$type<"month" | "year">().notNull().default("month"),
  currency: text().notNull().default("SEK"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  scheduledPlanId: uuid("scheduled_plan_id"),
  scheduledAddOnPlanIds: uuid("scheduled_add_on_plan_ids").array(),
  scheduledBillingPeriod: text("scheduled_billing_period").$type<"month" | "year">(),
  scheduledEffectiveAt: timestamp("scheduled_effective_at", tz),
  selectedAt: timestamp("selected_at", tz),
  pastDueSince: timestamp("past_due_since", tz),
  trialReminderLevel: integer("trial_reminder_level").notNull().default(0),
});
export const billingAccounts = billingSchema.table("accounts", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id").notNull(),
  legalName: text("legal_name").notNull(),
  organizationNumber: text("organization_number"),
  vatNumber: text("vat_number"),
  address: jsonb().$type<{
    street?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  }>(),
  invoiceEmail: text("invoice_email"),
  reference: text(),
  invoiceLocale: text("invoice_locale").$type<"sv" | "en" | "nb">().notNull().default("sv"),
  paymentMethod: text("payment_method").$type<"invoice" | "card">().notNull().default("invoice"),
  provider: text(),
  providerCustomerId: text("provider_customer_id"),
  providerPaymentMethodId: text("provider_payment_method_id"),
  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  cardExpMonth: integer("card_exp_month"),
  cardExpYear: integer("card_exp_year"),
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at", tz),
  updatedAt: timestamp("updated_at", tz),
});
export const billingInvoices = billingSchema.table("invoices", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id").notNull(),
  subscriptionId: uuid("subscription_id").notNull(),
  number: text(),
  currency: text().notNull(),
  totalMinor: bigint("total_minor", { mode: "number" }).notNull().default(0),
  status: text().$type<"draft" | "open" | "paid" | "void">().notNull().default("draft"),
  periodStart: timestamp("period_start", tz).notNull(),
  periodEnd: timestamp("period_end", tz).notNull(),
  issuedAt: timestamp("issued_at", tz),
  dueAt: timestamp("due_at", tz),
  paidAt: timestamp("paid_at", tz),
  // P1.13
  kind: text().$type<"invoice" | "credit_note">().notNull().default("invoice"),
  creditedInvoiceId: uuid("credited_invoice_id"),
  subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull().default(0),
  vatMinor: bigint("vat_minor", { mode: "number" }).notNull().default(0),
  seller: jsonb().$type<Record<string, unknown>>(),
  buyer: jsonb().$type<Record<string, unknown>>(),
  paymentMethod: text("payment_method"),
  ocrReference: text("ocr_reference"),
  creditReason: text("credit_reason"),
  pdfObjectKey: text("pdf_object_key"),
  pdfSha256: text("pdf_sha256"),
  reminderLevel: integer("reminder_level").notNull().default(0),
  lastRemindedAt: timestamp("last_reminded_at", tz),
  // P1.13 part B: card charge attempts.
  cardAttempts: integer("card_attempts").notNull().default(0),
  nextCardAttemptAt: timestamp("next_card_attempt_at", tz),
});
export const billingInvoiceLines = billingSchema.table("invoice_lines", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),
  descriptionKey: text("description_key").notNull(),
  quantity: integer().notNull().default(1),
  unitMinor: bigint("unit_minor", { mode: "number" }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  planId: uuid("plan_id"),
  periodStart: timestamp("period_start", tz),
  periodEnd: timestamp("period_end", tz),
  proration: boolean().notNull().default(false),
  vatRateBp: integer("vat_rate_bp").notNull().default(0),
  vatMinor: bigint("vat_minor", { mode: "number" }).notNull().default(0),
});
export const billingPayments = billingSchema.table("payments", {
  id: uuid().primaryKey(),
  clubId: uuid("club_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),
  provider: text().notNull(),
  providerReference: text("provider_reference").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text().notNull(),
  status: text().$type<"pending" | "succeeded" | "failed">().notNull(),
  failureCode: text("failure_code"),
  receivedOn: text("received_on"),
  recordedAt: timestamp("recorded_at", tz).notNull(),
});
