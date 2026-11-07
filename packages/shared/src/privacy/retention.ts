// SPDX-License-Identifier: AGPL-3.0-only
// The retention registry (P1.8a): every retention rule once, with the data
// it covers, its default and limits, the club setting if a club may change
// it, and the worker task that enforces it. The club's privacy page and
// policy read it; a docs test checks it against the table in docs/gdpr.md
// and the worker's task list. Rules of modules that do not exist yet are
// `planned`.

import type { ClubSettingKey } from "./club-settings.ts";

export interface RetentionRule {
  /** Stable key (message keys `privacy.retention.<key>.*`). */
  key: string;
  /** The duration, or a fixed description key when it is not a duration. */
  period: { value: number; unit: "hours" | "days" | "months" | "years" } | "until_erased";
  /** The club setting that changes it, if a club may. */
  setting?: ClubSettingKey;
  /** An installation setting (environment variable) that changes it. */
  installationSetting?: string;
  /** The worker task that enforces it. */
  task?: string;
  status: "implemented" | "planned";
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    key: "former_member_profile",
    period: { value: 24, unit: "months" },
    setting: "former_member_retention_months",
    task: "privacy:retention",
    status: "implemented",
  },
  {
    key: "orphaned_people",
    period: { value: 36, unit: "months" },
    installationSetting: "ORPHAN_RETENTION_MONTHS",
    task: "privacy:retention",
    status: "implemented",
  },
  {
    key: "attendance",
    period: { value: 12, unit: "months" },
    setting: "attendance_retention_months",
    task: "attendance:retention",
    status: "implemented",
  },
  {
    key: "event_registrations",
    period: { value: 12, unit: "months" },
    setting: "attendance_retention_months",
    task: "attendance:retention",
    status: "implemented",
  },
  {
    key: "sensitive_event_answers",
    period: { value: 30, unit: "days" },
    task: "attendance:retention",
    status: "implemented",
  },
  {
    key: "join_requests",
    period: { value: 12, unit: "months" },
    task: "joining:retention",
    status: "implemented",
  },
  {
    key: "unaccepted_invitations",
    period: { value: 12, unit: "months" },
    task: "joining:retention",
    status: "implemented",
  },
  {
    key: "member_export_files",
    period: { value: 24, unit: "hours" },
    task: "members:expire_exports",
    status: "implemented",
  },
  {
    key: "member_import_rows",
    period: { value: 7, unit: "days" },
    task: "members:purge_imports",
    status: "implemented",
  },
  {
    key: "data_export_files",
    period: { value: 7, unit: "days" },
    task: "privacy:expire_exports",
    status: "implemented",
  },
  {
    key: "data_export_requests",
    period: { value: 12, unit: "months" },
    task: "privacy:retention",
    status: "implemented",
  },
  {
    key: "erasure_requests",
    period: { value: 24, unit: "months" },
    task: "privacy:retention",
    status: "implemented",
  },
  {
    key: "notifications",
    period: { value: 90, unit: "days" },
    task: "notifications:retention",
    status: "implemented",
  },
  {
    key: "notification_deliveries",
    period: { value: 30, unit: "days" },
    task: "notifications:retention",
    status: "implemented",
  },
  {
    key: "push_devices",
    period: { value: 90, unit: "days" },
    task: "notifications:retention",
    status: "implemented",
  },
  {
    key: "audit_log",
    period: { value: 24, unit: "months" },
    installationSetting: "AUDIT_RETENTION_MONTHS",
    task: "audit:retention",
    status: "implemented",
  },
  {
    key: "record_history",
    period: { value: 24, unit: "months" },
    installationSetting: "HISTORY_RETENTION_MONTHS",
    task: "history:maintain_partitions",
    status: "implemented",
  },
  { key: "backups", period: { value: 12, unit: "months" }, status: "implemented" },
  {
    key: "profile_views",
    period: { value: 24, unit: "months" },
    task: "privacy:profile_views",
    status: "implemented",
  },
  {
    key: "anonymization_ledger",
    period: { value: 13, unit: "months" },
    task: "privacy:profile_views",
    status: "implemented",
  },
  {
    key: "calendar_feeds",
    period: { value: 30, unit: "days" },
    task: "calendar:retention",
    status: "implemented",
  },
  {
    // Billing of the service (P1.13; BILLING_ENABLED only): invoices, credit
    // notes, lines and payments, 7 years after the end of the invoice's year.
    key: "accounting_records",
    period: { value: 7, unit: "years" },
    task: "billing:retention",
    status: "implemented",
  },
  { key: "chat_messages", period: { value: 24, unit: "months" }, status: "planned" },
  { key: "background_checks", period: { value: 12, unit: "months" }, status: "planned" },
  { key: "restorable_club_profiles", period: { value: 60, unit: "months" }, status: "planned" },
];

export const RETENTION_RULE_KEYS = RETENTION_RULES.map((rule) => rule.key);
