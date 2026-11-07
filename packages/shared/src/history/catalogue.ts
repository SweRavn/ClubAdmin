// SPDX-License-Identifier: AGPL-3.0-only
// What the history and audit views name (P1.9, ADR 0042): the kinds of
// records (one label each, shared by the history panels and the audit log's
// resource types), the audit log's categories and the composed action
// sentences. Few message keys: an action's sentence is its verb (the last
// segment) with the resource's label, unless the action has its own
// sentence (AUDIT_ACTION_SENTENCES) because the composed one reads wrongly.

import { AUDIT_ACTIONS, type AuditAction } from "../audit-actions.ts";

/**
 * Kinds of records in history and audit (`history.resources.<key>`): a
 * history-enabled table's singular name, also used as audit resource_type.
 */
export const HISTORY_RESOURCES = [
  "person",
  "club_profile",
  "club_membership",
  "group_membership",
  "club_role_assignment",
  "employment",
  "consent",
  "join_request",
  "group_waitlist_entry",
  "guardianship",
  "group",
  "group_owner",
  "group_season",
  "season",
  "activity",
  "activity_group",
  "activity_response",
  "attendance_record",
  "activity_invitee",
  "activity_series",
  "activity_series_group",
  "event",
  "event_group",
  "event_activity",
  "event_registration",
  "club",
  "location",
  "club_phone_number",
  "consent_text",
  "club_setting_decision",
  "club_privacy_policy",
  "support_access_grant",
  "invitation",
  "invitation_acceptance",
  "member_export",
  "member_import",
  "club_manager_handover",
  "club_manager_reassignment",
  // Audit resource types of a club's log without a panel table of their own
  // (account-level events have no club and never appear in a club's log).
  "guardian_invitation",
  "subscription",
] as const;
export type HistoryResource = (typeof HISTORY_RESOURCES)[number];

export const isHistoryResource = (value: string): value is HistoryResource =>
  (HISTORY_RESOURCES as readonly string[]).includes(value);

/**
 * The kinds of records the club-wide changes can be filtered by: the club
 * rows of the history view policy (apps/api audit module; a test keeps them
 * in step).
 */
export const CLUB_HISTORY_RESOURCES = [
  "club_profile",
  "club_membership",
  "group_membership",
  "club_role_assignment",
  "employment",
  "consent",
  "join_request",
  "group_waitlist_entry",
  "group",
  "group_owner",
  "group_season",
  "season",
  "activity",
  "activity_group",
  "activity_response",
  "attendance_record",
  "activity_invitee",
  "activity_series",
  "activity_series_group",
  "event",
  "event_group",
  "event_activity",
  "event_registration",
  "club",
  "location",
  "club_phone_number",
  "consent_text",
  "club_setting_decision",
  "club_privacy_policy",
  "support_access_grant",
  "invitation",
  "invitation_acceptance",
  "member_export",
  "member_import",
  "club_manager_handover",
  "club_manager_reassignment",
] as const satisfies readonly HistoryResource[];

/** Categories of the audit log filter (`audit.categories.<key>`). */
export const AUDIT_CATEGORIES = [
  "members",
  "roles",
  "groups",
  "activities",
  "attendance",
  "events",
  "families",
  "privacy",
  "exports",
  "settings",
  "access",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** First match wins: specific prefixes before general ones. */
const CATEGORY_RULES: readonly [AuditCategory, readonly string[]][] = [
  [
    "exports",
    ["members.exported", "members.export.", "event.registrations.exported", "privacy.export."],
  ],
  [
    "privacy",
    [
      "consent.",
      "consent_text.",
      "club.settings.decided",
      "club.privacy_policy.",
      "person.club_data.purged",
      "person.erased",
      "person.erasure.",
      "account.deletion.",
    ],
  ],
  [
    "access",
    [
      "person.protected.viewed",
      "person.personal_identity_number.viewed",
      "person.protection.",
      "session.",
      "invitation.",
      "club.manager.claimed",
      "club.manager.reassigned",
      "club.access_state.",
      "account.",
      "push_device.",
      "calendar_feed.",
      "notifications.",
      "backup.",
    ],
  ],
  ["roles", ["club.role.", "club.manager.", "group.owner."]],
  ["attendance", ["attendance.", "activity.response."]],
  ["activities", ["activity.", "location."]],
  ["events", ["event."]],
  ["families", ["guardianship.", "person.merged", "person.merge."]],
  ["groups", ["group."]],
  ["members", ["membership.", "members.", "join_request.", "person.", "club.profile."]],
  ["settings", ["club.", "billing."]],
];

export function auditCategoryOf(action: string): AuditCategory {
  for (const [category, prefixes] of CATEGORY_RULES) {
    if (
      prefixes.some((p) =>
        p.endsWith(".") ? action.startsWith(p) : action === p || action.startsWith(`${p}.`),
      )
    ) {
      return category;
    }
  }
  return "settings";
}

/** The registered actions of a category (the audit log's category filter). */
export const auditActionsOf = (category: AuditCategory): AuditAction[] =>
  AUDIT_ACTIONS.filter((a) => auditCategoryOf(a) === category);

/**
 * Actions with a sentence of their own (`audit.actions.<action with dots as
 * underscores>`), where "verb: resource" would read wrongly.
 */
export const AUDIT_ACTION_SENTENCES: readonly AuditAction[] = [
  "members.exported",
  "members.export.downloaded",
  "event.registrations.exported",
  "person.protected.viewed",
  "person.personal_identity_number.viewed",
  "activity.response.set_by_leader",
  "membership.type.changed",
  "account.email.changed",
  "club.phone_numbers.updated",
  "guardianship.ward.adult",
  "guardianship.adult.decided",
  "billing.subscription.plan.changed",
  "billing.subscription.status.changed",
  "club.access_state.changed",
  "activity.series.split",
  "activity.invitees.changed",
  "group.waitlist.withdrawn",
  "group.waitlist.priority_changed",
  "group.waitlist.offer_withdrawn",
  "group.waitlist.admitted",
  "calendar_feed.regenerated",
  "person.protection.removal_refused",
  "person.club_data.purged",
  "club.settings.decided",
];

/** The verb of an action (`audit.verbs.<verb>`): its last segment. */
export const auditVerbOf = (action: string): string => action.slice(action.lastIndexOf(".") + 1);

/** The sentence key of an action: its own, or the composed verb. */
export function auditSentenceKey(action: string): { own: string } | { verb: string } {
  return (AUDIT_ACTION_SENTENCES as readonly string[]).includes(action)
    ? { own: action.replaceAll(".", "_") }
    : { verb: auditVerbOf(action) };
}

/** Every verb the registered actions compose with. */
export const AUDIT_VERBS: readonly string[] = [
  ...new Set(
    AUDIT_ACTIONS.filter((a) => !(AUDIT_ACTION_SENTENCES as readonly string[]).includes(a)).map(
      auditVerbOf,
    ),
  ),
].sort();
