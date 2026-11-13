// SPDX-License-Identifier: AGPL-3.0-only
// Tables without the record-history trigger (ADR 0017). Every entry needs a
// reason. Patterns: "schema.table" or "schema.*".

export const HISTORY_EXCLUSIONS: Record<string, string> = {
  "history.*": "the history itself",
  "audit.*": "append-only audit log; the app roles cannot change it",
  "outbox.*": "transient delivery bookkeeping, IDs only",
  "privacy.deletion_ledger":
    "append-only list of erased person IDs; must survive restores unchanged",
  "app_meta.*": "migration bookkeeping",
  "graphile_worker.*": "job queue managed by Graphile Worker",
  "crypto.*": "wrapped encryption keys; no personal data, rotated by operators",
  "ops.*": "backup and restore bookkeeping written by the backup tooling; no personal data",
  "public.schedule_entries":
    "the calendars' read model, derived from activities and activity_groups (which have history) in the same transaction",
  "public.notification_deliveries":
    "delivery log of notifications (status, attempts, provider IDs; no personal values), high volume, deleted after 30 days (P1.7)",
  "billing.invoice_number_series":
    "the next invoice number per seller (a counter keyed by text; every number is on its invoice, which has history)",
  "billing.provider_events":
    "card provider webhook bookkeeping (event IDs and processing state only, no payload), deleted after 90 days (P1.13)",
  "public.profile_views":
    "the profile view log (P1.12) is itself a log, rewritten by the daily upsert; IDs, dates and counts only",
  "privacy.anonymization_ledger":
    "append-only list of (person, club) anonymisations; must survive restores unchanged (P1.12)",
  "app.administrator_minimum_exceptions":
    "transaction-local markers of a confirmed suspension or an erasure (P1.15 A3): owner-only (no application role has a privilege), cleared on the next use, IDs only",
  "public.document_views":
    "when a person last looked at a club's or group's documents (P2.2): a bookmark rewritten on every visit, IDs and times only",
  "public.member_import_rows":
    "staging rows of a member import (the file's values), deleted seven days after the import ends; the people created from them have history",
};

export function isHistoryExcluded(qualifiedName: string): boolean {
  const [schema] = qualifiedName.split(".");
  return qualifiedName in HISTORY_EXCLUSIONS || `${schema}.*` in HISTORY_EXCLUSIONS;
}
