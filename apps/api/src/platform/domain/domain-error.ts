// SPDX-License-Identifier: AGPL-3.0-only
// Expected failures of the domain services, with a stable machine-readable
// code. They are ProblemErrors, so endpoints answer with the mapped problem
// type and the code as `detail`. Codes and messages never contain personal
// data; database errors are not attached as causes (their `detail` may hold
// values such as an email address).

import type { ProblemSlug } from "@clubadmin/shared";

import { ProblemError } from "../http/problem-error.ts";

export const DOMAIN_ERRORS = {
  not_found: "not-found",
  not_allowed: "forbidden",
  invalid_input: "validation",
  /** A pagination cursor that is not an item of the list (any more). */
  invalid_cursor: "bad-request",
  // History and audit (P1.9)
  /** A panel with more records than HISTORY_SCOPE_MAX: use the club-wide view. */
  history_scope_too_large: "conflict",
  /** A period longer than allowed (90 days for filtered changes, 400 for the audit log). */
  range_too_large: "validation",
  /** A history read ran into the history pool's statement timeout. */
  history_timeout: "unavailable",
  // people
  protected_address: "validation",
  invalid_personal_identity_number: "validation",
  personal_identity_number_mismatch: "validation",
  encryption_unavailable: "unavailable",
  merge_not_allowed: "conflict",
  merge_undo_expired: "conflict",
  merge_undo_conflict: "conflict",
  // accounts
  email_taken: "conflict",
  account_exists: "conflict",
  too_young_for_account: "conflict",
  // clubs and roles
  club_slug_taken: "conflict",
  unsupported_country: "validation",
  invalid_organization_number: "validation",
  role_already_assigned: "conflict",
  last_club_manager: "conflict",
  not_a_club_manager: "forbidden",
  handover_invalid: "conflict",
  // groups
  /** A full group: adding a member needs overCapacity (P1.10a). */
  group_full: "conflict",
  /** A group owner must be an adult member of the club with a login (P1.10a). */
  owner_not_eligible: "conflict",
  group_cycle: "conflict",
  group_parent_invalid: "validation",
  group_archived: "conflict",
  group_has_children: "conflict",
  group_in_use: "conflict",
  already_group_owner: "conflict",
  // Calendar subscriptions (P1.11, ADR 0044)
  too_many_feeds: "conflict",
  feed_scope_invalid: "validation",
  /** The installation has calendar feeds off (or no key to sign answer links). */
  protection_removal_not_allowed: "forbidden",
  not_a_full_guardian: "forbidden",
  calendar_feeds_unavailable: "not-found",
  answer_link_invalid: "not-found",
  /** The activity ended or the feed was revoked. */
  answer_link_expired: "gone",
  // Waiting lists (P1.10b, ADR 0043)
  /** The group takes no applications (admission_mode = closed, or direct and not full). */
  admission_closed: "conflict",
  already_on_waitlist: "conflict",
  not_on_waitlist: "conflict",
  /** The entry is closed (or in a status the step does not apply to). */
  waitlist_entry_closed: "conflict",
  /** Someone waiting is ahead: offering or admitting needs a reason. */
  out_of_order_reason_required: "validation",
  /** People are waiting: adding a member directly needs a reason. */
  queue_bypass_reason_required: "validation",
  priority_reason_required: "validation",
  join_request_rejected: "conflict",
  // memberships
  already_member: "conflict",
  join_not_allowed: "forbidden",
  not_a_member: "conflict",
  already_in_group: "conflict",
  // guardianships
  guardianship_exists: "conflict",
  invitation_invalid: "conflict",
  // Families (P1.3)
  birth_date_in_future: "validation",
  rights_not_allowed: "forbidden",
  guardianship_kind_not_allowed: "forbidden",
  too_young_to_link: "conflict",
  reason_required: "validation",
  adult_decision_not_open: "conflict",
  invitation_not_pending: "conflict",
  person_has_account: "conflict",
  /** A club manager without a second factor ending a full guardian's guardianship. */
  mfa_required: "mfa-required",
  // Sign-up and joining (P1.1)
  profile_incomplete: "conflict",
  email_not_verified: "forbidden",
  club_creation_not_allowed: "forbidden",
  creation_request_exists: "conflict",
  join_request_exists: "conflict",
  not_guardian: "forbidden",
  invitation_email_mismatch: "conflict",
  invitation_email_unavailable: "unavailable",
  role_preset_not_allowed: "forbidden",
  club_has_manager: "conflict",
  // Member register (P1.2)
  register_filter_not_allowed: "forbidden",
  export_limit_reached: "rate-limited",
  export_not_available: "conflict",
  export_storage_unavailable: "unavailable",
  invalid_end_date: "validation",
  membership_status_invalid: "conflict",
  // Adding and importing members (P1.3b)
  member_number_taken: "conflict",
  start_date_invalid: "validation",
  minor_email_not_allowed: "validation",
  consent_note_required: "validation",
  invitation_limit_reached: "rate-limited",
  import_storage_unavailable: "unavailable",
  import_format_unsupported: "validation",
  import_file_too_large: "validation",
  import_file_missing: "conflict",
  import_not_uploaded: "conflict",
  import_not_in_review: "conflict",
  import_not_cancellable: "conflict",
  import_mapping_incomplete: "validation",
  import_limit_reached: "rate-limited",
  // Activities (P1.4)
  location_name_taken: "conflict",
  location_archived: "conflict",
  invalid_recurrence: "validation",
  nonexistent_local_time: "validation",
  series_too_long: "validation",
  series_change_in_past: "conflict",
  not_a_series_session: "conflict",
  range_too_long: "validation",
  group_not_managed: "forbidden",
  activity_cancelled: "conflict",
  activity_not_cancelled: "conflict",
  // Responses and attendance (P1.5)
  activity_has_responses: "conflict",
  response_not_requested: "conflict",
  response_closed: "conflict",
  not_on_roster: "conflict",
  activity_ended: "conflict",
  activity_not_started: "conflict",
  attendance_locked: "forbidden",
  correction_reason_required: "validation",
  not_a_club_member: "validation",
  recorded_at_out_of_range: "validation",
  // Events with sign-up (P1.6)
  registration_closed: "conflict",
  registration_not_open: "conflict",
  event_full: "conflict",
  already_registered: "conflict",
  not_registered: "conflict",
  not_in_audience: "conflict",
  cancellation_closed: "conflict",
  no_offer: "conflict",
  offer_expired: "conflict",
  event_cancelled: "conflict",
  event_not_draft: "conflict",
  event_not_published: "conflict",
  answer_required: "validation",
  answer_invalid: "validation",
  activity_has_call_up: "conflict",
  activity_in_other_event: "conflict",
  capacity_below_confirmed: "conflict",
  questions_locked: "conflict",
  event_period_invalid: "validation",
  // Notifications (P1.7)
  /** Email cannot be turned off for a category whose notices all require it. */
  notification_mandatory: "validation",
  push_not_available: "conflict",
  unsubscribe_token_invalid: "bad-request",
  // Privacy (P1.8a)
  consent_purpose_not_asked: "conflict",
  /** Photo, video, streaming and contact purposes for a protected person. */
  consent_not_applicable: "conflict",
  /** The person has not reached the consent age, or a guardian gives past it. */
  consent_age_required: "forbidden",
  consent_text_outdated: "conflict",
  consent_text_language_required: "validation",
  /** Leaving (or removing everything) while holding club roles, leader functions or ownerships. */
  roles_must_be_removed: "conflict",
  /** Leaving while invoices from the club are neither paid nor written off. */
  outstanding_invoices: "conflict",
  /** A board setting changed without a recorded decision. */
  decision_required: "validation",
  decision_invalid: "validation",
  // Privacy (P1.8b): "download my data", account deletion, ward erasure
  /** The file of a data export was deleted (after seven days) or never written. */
  export_expired: "conflict",
  /** An erasure of the person is already scheduled or running. */
  erasure_pending: "conflict",
  /** Roles, leader functions, ownerships or invoices remain (the preview names them). */
  erasure_blocked: "conflict",
  /** A ward with a login of their own deletes their account themselves. */
  ward_has_login: "conflict",
  /** Erasure needs the retention role, which this installation has not configured. */
  erasure_unavailable: "unavailable",
  // Billing (P0.12)
  plan_not_found: "not-found",
  no_subscription: "not-found",
  subscription_transition_invalid: "conflict",
  // Billing (P1.13)
  price_not_available: "conflict",
  paid_plan_unavailable: "conflict",
  billing_details_incomplete: "conflict",
  terms_not_accepted: "validation",
  payment_method_unavailable: "conflict",
  invoice_not_found: "not-found",
  invoice_not_open: "conflict",
  payment_exceeds_balance: "conflict",
  payment_reference_used: "conflict",
  credit_lines_invalid: "validation",
  credit_exceeds_invoice: "conflict",
  open_invoices: "conflict",
  pdf_unavailable: "unavailable",
  plan_key_taken: "conflict",
  provider_signature_invalid: "bad-request",
  // Club-defined roles (P1.15 A2).
  role_changed: "conflict",
  role_locked: "conflict",
  invalid_replacement_role: "validation",
  permission_not_for_group_roles: "validation",
  /** Assigning a role with permissions the caller does not hold (no escalation). */
  role_not_allowed: "forbidden",
  // At least two administrators; suspending one (P1.15 A3).
  /** Fewer than two administrators who count, outside the grace period: no new members. */
  club_needs_administrators: "conflict",
  /** The change would leave fewer than two administrators (database constraint). */
  administrators_minimum: "conflict",
  not_an_administrator: "conflict",
  suspension_requested: "conflict",
  suspension_not_open: "conflict",
  /** The target, the initiator, or someone who may not confirm. */
  suspension_not_allowed: "forbidden",
  grace_already_extended: "conflict",
  no_grace_period: "conflict",
} as const satisfies Record<string, ProblemSlug>;

export type DomainErrorCode = keyof typeof DOMAIN_ERRORS;

export class DomainError extends ProblemError {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super(DOMAIN_ERRORS[code], { detail: code });
    this.name = "DomainError";
    this.code = code;
  }
}

export const isDomainError = (error: unknown, code?: DomainErrorCode): error is DomainError =>
  error instanceof DomainError && (code === undefined || error.code === code);
