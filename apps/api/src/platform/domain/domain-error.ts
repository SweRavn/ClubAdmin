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
  role_already_assigned: "conflict",
  last_club_manager: "conflict",
  not_a_club_manager: "forbidden",
  handover_invalid: "conflict",
  // groups
  group_cycle: "conflict",
  group_parent_invalid: "validation",
  group_archived: "conflict",
  already_group_owner: "conflict",
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
  // Billing (P0.12)
  plan_not_found: "not-found",
  no_subscription: "not-found",
  subscription_transition_invalid: "conflict",
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
