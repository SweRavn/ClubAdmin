// SPDX-License-Identifier: AGPL-3.0-only
// The history view policy (P1.9, ADR 0042): for every history-enabled table
// that a panel or the club-wide view shows, the kind of record it is, the
// detail page it belongs to, whom and what it is about, and for every
// column how it is shown:
// - hidden: never (IDs, timestamps of the row itself, hashes, ciphertext);
// - name_only: not named, counted in "Other fields changed" (also every
//   column not listed: new columns stay unnamed until classified);
// - value: old and new value, formatted (enum keys, dates, numbers);
// - person / ref: an ID resolved to a person (through the presenter) or a
//   record's name;
// - shared: a person's field shown only while they share it with the club
//   (club_profiles.shared_fields); otherwise left out entirely;
// - leader_notes: a value only for those who read the activity's answers
//   (activity.responses.read) or manage the club; otherwise name_only.
// Tables never shown are in NEVER_SHOWN with a reason. Tests guard both
// against the database catalogue and the Drizzle schema.

import type { HistoryRecordKind, HistoryResource } from "@clubadmin/shared";

export type ValueFormat =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | { enum: string }
  | { list: "text" | { enum: string } };

export type ColumnRule =
  | "hidden"
  | "name_only"
  | { kind: "value"; format: ValueFormat; label: string }
  | { kind: "person"; label: string }
  | { kind: "ref"; ref: HistoryRecordKind; label: string }
  | { kind: "shared"; field: "phone" | "address" | "gender"; format: ValueFormat; label: string }
  | { kind: "leader_notes"; label: string };

export interface TablePolicy {
  /** Schema-qualified table name. */
  table: string;
  resource: HistoryResource;
  /** The detail page the record belongs to: its kind and the column holding its ID. */
  link: { kind: HistoryRecordKind; column: string } | null;
  /** Columns naming whom and what the record is about, resolved from the current row. */
  about: readonly { column: string; kind: HistoryRecordKind }[];
  /** True for global tables (club_id NULL), read through history.read_global_changes. */
  global?: boolean;
  columns: Readonly<Record<string, ColumnRule>>;
}

/** Columns hidden on every table (the row's own bookkeeping). */
export const ALWAYS_HIDDEN = ["id", "club_id", "created_at", "updated_at"] as const;

const c = (name: string) => `history.columns.${name}`;
const value = (format: ValueFormat, label: string): ColumnRule => ({
  kind: "value",
  format,
  label,
});
const text = (name: string, label = c(name)) => value("text", label);
const date = (name: string, label = c(name)) => value("date", label);
const datetime = (name: string, label = c(name)) => value("datetime", label);
const num = (name: string, label = c(name)) => value("number", label);
const bool = (name: string, label = c(name)) => value("boolean", label);
const enumOf = (name: string, key: string): ColumnRule => value({ enum: key }, c(name));
const person = (name: string): ColumnRule => ({ kind: "person", label: c(name) });
const ref = (name: string, kind: HistoryRecordKind): ColumnRule => ({
  kind: "ref",
  ref: kind,
  label: c(name),
});
const STATUS = "history.statuses";

const validity = { valid_from: date("valid_from"), valid_to: date("valid_to") };

export const HISTORY_POLICY: readonly TablePolicy[] = [
  // The person (global rows, through history.read_global_changes).
  {
    table: "public.people",
    resource: "person",
    link: { kind: "person", column: "id" },
    about: [{ column: "id", kind: "person" }],
    global: true,
    columns: {
      // Name columns are not listed (name_only): names reach the API only through
      // PersonPresenter (ADR 0022); the person's current name is in "about".
      birth_date: date("birth_date", "profileForm.birthDate"),
      gender: { kind: "shared", field: "gender", format: { enum: "genders" }, label: c("gender") },
      phone: { kind: "shared", field: "phone", format: "text", label: c("phone") },
      address: "name_only",
      personal_identity_number: "name_only",
      personal_identity_number_hash: "hidden",
      protected_identity: bool("protected_identity"),
      // Who set the flag (P1.12): shown to club managers on the profile, not here.
      protected_identity_set_by_person_id: "hidden",
      protected_identity_set_at: "hidden",
      deceased_at: "name_only",
      anonymized_at: "name_only",
      merged_into_person_id: "hidden",
      created_by_person_id: "hidden",
      orphaned_since: "hidden",
    },
  },
  {
    table: "public.guardianships",
    resource: "guardianship",
    link: { kind: "person", column: "ward_person_id" },
    about: [
      { column: "ward_person_id", kind: "person" },
      { column: "guardian_person_id", kind: "person" },
    ],
    global: true,
    columns: {
      guardian_person_id: "hidden",
      ward_person_id: "hidden",
      kind: enumOf("kind", "guardianKinds"),
      rights: value({ list: { enum: "guardianRights" } }, c("rights")),
      status: enumOf("status", STATUS),
      ...validity,
      created_by_person_id: "hidden",
      granted_by_person_id: "hidden",
      recorded_by_club_id: "hidden",
      ward_adult_flagged_at: "hidden",
      adult_decision: "name_only",
      adult_decided_at: "hidden",
      consent_note: "name_only",
      ended_reason: text("ended_reason"),
      own_login_age_notified_at: "hidden",
    },
  },
  // The person in a club.
  {
    table: "public.club_profiles",
    resource: "club_profile",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      member_number: num("member_number"),
      shared_fields: value({ list: "text" }, c("shared_fields")),
      emergency_contacts: "name_only",
      notes: "name_only",
      protected_identity_club: bool("protected_identity_club"),
      protected_identity_club_set_by_person_id: "hidden",
      protected_identity_club_set_at: "hidden",
      club_data_purged_at: "name_only",
    },
  },
  {
    table: "public.club_memberships",
    resource: "club_membership",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      status: enumOf("status", "membershipStatus"),
      membership_type: enumOf("membership_type", "membershipTypes"),
      ...validity,
    },
  },
  {
    table: "public.group_memberships",
    resource: "group_membership",
    link: { kind: "group", column: "group_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "group_id", kind: "group" },
    ],
    columns: {
      group_id: "hidden",
      person_id: "hidden",
      function: enumOf("function", "functions"),
      queue_bypass_reason: text("queue_bypass_reason"),
      ...validity,
    },
  },
  {
    table: "public.club_role_assignments",
    resource: "club_role_assignment",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      role: "name_only",
      assigned_by_person_id: "hidden",
      ended_by_person_id: "hidden",
      ...validity,
    },
  },
  {
    table: "public.employments",
    resource: "employment",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      title: text("title"),
      employment_type: "name_only",
      starts_on: date("starts_on"),
      ends_on: date("ends_on"),
      hours_per_week: "name_only",
    },
  },
  {
    table: "public.consents",
    resource: "consent",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      purpose: enumOf("purpose", "consentPurposes"),
      text_version: "name_only",
      given_by_person_id: "hidden",
      given_at: "name_only",
      revoked_at: datetime("revoked_at"),
      revoked_by_person_id: "hidden",
      source: text("source"),
      club_note: "name_only",
      revoked_reason: text("revoked_reason"),
    },
  },
  {
    table: "public.join_requests",
    resource: "join_request",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      requested_by_person_id: "hidden",
      status: enumOf("status", "joinRequestStatus"),
      message: "name_only",
      preferred_group_ids: "name_only",
      decided_by_person_id: "hidden",
      decided_at: "name_only",
      decision_message: "name_only",
    },
  },
  {
    table: "public.group_waitlist_entries",
    resource: "group_waitlist_entry",
    link: { kind: "group", column: "group_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "group_id", kind: "group" },
    ],
    columns: {
      group_id: "hidden",
      person_id: "hidden",
      requested_by_person_id: "hidden",
      status: enumOf("status", STATUS),
      queued_at: "name_only",
      priority: num("priority"),
      offer_expires_at: "name_only",
      applicant_note: "name_only",
      owner_note: "name_only",
      out_of_order_reason: text("out_of_order_reason"),
      decided_by_person_id: "hidden",
      decided_at: "name_only",
      closed_reason: enumOf("closed_reason", "history.closedReasons"),
      // P1.10b
      offered_at: "name_only",
      offered_by_person_id: "hidden",
      join_request_id: "hidden",
      priority_reason: enumOf("priority_reason", "history.priorityReasons"),
    },
  },
  // Groups.
  {
    table: "public.groups",
    resource: "group",
    link: { kind: "group", column: "id" },
    about: [{ column: "id", kind: "group" }],
    columns: {
      parent_group_id: ref("parent_group_id", "group"),
      kind: enumOf("kind", "kinds"),
      name: text("name", "groupForm.name"),
      sport: "name_only",
      birth_year_from: num("birth_year_from", "groupForm.birthYearFrom"),
      birth_year_to: num("birth_year_to", "groupForm.birthYearTo"),
      gender_category: value({ enum: "groupForm.genderCategories" }, "groupForm.genderCategory"),
      level: text("level", "groupForm.level"),
      capacity: num("capacity"),
      admission_mode: value({ enum: "groupForm.admissionModes" }, "groupForm.admissionMode"),
      waitlist_visible_publicly: "name_only",
      offer_reply_days: num("offer_reply_days", "groupForm.offerReplyDays"),
      waitlist_auto_offer: "name_only",
      archived_at: datetime("archived_at"),
    },
  },
  {
    table: "public.group_owners",
    resource: "group_owner",
    link: { kind: "group", column: "group_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "group_id", kind: "group" },
    ],
    columns: {
      group_id: "hidden",
      person_id: "hidden",
      assigned_by_person_id: "hidden",
      ...validity,
    },
  },
  {
    table: "public.group_seasons",
    resource: "group_season",
    link: { kind: "group", column: "group_id" },
    about: [
      { column: "group_id", kind: "group" },
      { column: "season_id", kind: "season" },
    ],
    columns: {
      group_id: "hidden",
      season_id: "hidden",
      capacity: num("capacity"),
      notes: "name_only",
    },
  },
  {
    table: "public.seasons",
    resource: "season",
    link: { kind: "club", column: "club_id" },
    about: [{ column: "id", kind: "season" }],
    columns: { name: text("name"), starts_on: date("starts_on"), ends_on: date("ends_on") },
  },
  // Activities.
  {
    table: "public.activities",
    resource: "activity",
    link: { kind: "activity", column: "id" },
    about: [{ column: "id", kind: "activity" }],
    columns: {
      series_id: "hidden",
      occurrence_on: "hidden",
      kind: enumOf("kind", "activityKinds"),
      kind_label: "name_only",
      title: text("title"),
      status: enumOf("status", STATUS),
      cancelled_reason: text("cancelled_reason"),
      starts_at: datetime("starts_at"),
      ends_at: datetime("ends_at"),
      all_day: "name_only",
      meet_at: datetime("meet_at"),
      meet_place: "name_only",
      location_id: ref("location_id", "location"),
      location_text: text("location_text"),
      notes: "name_only",
      leader_notes: "name_only",
      opponent: text("opponent"),
      home_away: enumOf("home_away", "homeAway"),
      competition: "name_only",
      detached: "hidden",
      sequence: "hidden",
      changed_at: "hidden",
      created_by_person_id: "hidden",
      response_mode: enumOf("response_mode", "responseModes"),
      respond_by: "name_only",
      invitees_only: "name_only",
    },
  },
  {
    table: "public.activity_groups",
    resource: "activity_group",
    link: { kind: "activity", column: "activity_id" },
    about: [
      { column: "activity_id", kind: "activity" },
      { column: "group_id", kind: "group" },
    ],
    columns: { activity_id: "hidden", group_id: "hidden" },
  },
  {
    table: "public.activity_responses",
    resource: "activity_response",
    link: { kind: "activity", column: "activity_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "activity_id", kind: "activity" },
    ],
    columns: {
      activity_id: "hidden",
      person_id: "hidden",
      status: enumOf("status", "responseStatus"),
      note: { kind: "leader_notes", label: c("note") },
      responded_by_person_id: "hidden",
      responded_at: "hidden",
    },
  },
  {
    table: "public.attendance_records",
    resource: "attendance_record",
    link: { kind: "activity", column: "activity_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "activity_id", kind: "activity" },
    ],
    columns: {
      activity_id: "hidden",
      person_id: "hidden",
      status: enumOf("status", "attendanceStatus"),
      role: "name_only",
      guest: "name_only",
      recorded_by_person_id: "hidden",
      recorded_at: "hidden",
      corrected_reason: text("corrected_reason"),
    },
  },
  {
    table: "public.activity_invitees",
    resource: "activity_invitee",
    link: { kind: "activity", column: "activity_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "activity_id", kind: "activity" },
    ],
    columns: {
      activity_id: "hidden",
      person_id: "hidden",
      invited_by_person_id: "hidden",
    },
  },
  {
    table: "public.activity_series",
    resource: "activity_series",
    link: { kind: "series", column: "id" },
    about: [{ column: "id", kind: "series" }],
    columns: {
      kind: enumOf("kind", "activityKinds"),
      title: text("title"),
      notes: "name_only",
      leader_notes: "name_only",
      location_id: ref("location_id", "location"),
      location_text: text("location_text"),
      slots: "name_only",
      starts_on: date("starts_on"),
      ends_on: date("ends_on"),
      skip_dates: "name_only",
      skip_public_holidays: "name_only",
      created_by_person_id: "hidden",
      response_mode: enumOf("response_mode", "responseModes"),
      respond_by_minutes: "name_only",
    },
  },
  {
    table: "public.activity_series_groups",
    resource: "activity_series_group",
    link: { kind: "series", column: "series_id" },
    about: [
      { column: "series_id", kind: "series" },
      { column: "group_id", kind: "group" },
    ],
    columns: { series_id: "hidden", group_id: "hidden" },
  },
  // Events.
  {
    table: "public.events",
    resource: "event",
    link: { kind: "event", column: "id" },
    about: [{ column: "id", kind: "event" }],
    columns: {
      title: text("title"),
      description: "name_only",
      audience: "name_only",
      status: enumOf("status", STATUS),
      cancelled_reason: text("cancelled_reason"),
      starts_at: datetime("starts_at"),
      ends_at: datetime("ends_at"),
      location_id: ref("location_id", "location"),
      location_text: text("location_text"),
      price_text: "name_only",
      registration_opens_at: datetime("registration_opens_at"),
      registration_closes_at: datetime("registration_closes_at"),
      cancellation_closes_at: "name_only",
      capacity: num("capacity"),
      waitlist_mode: "name_only",
      offer_reply_hours: "name_only",
      questions: "name_only",
      created_by_person_id: "hidden",
    },
  },
  {
    table: "public.event_groups",
    resource: "event_group",
    link: { kind: "event", column: "event_id" },
    about: [
      { column: "event_id", kind: "event" },
      { column: "group_id", kind: "group" },
    ],
    columns: { event_id: "hidden", group_id: "hidden" },
  },
  {
    table: "public.event_activities",
    resource: "event_activity",
    link: { kind: "event", column: "event_id" },
    about: [
      { column: "event_id", kind: "event" },
      { column: "activity_id", kind: "activity" },
    ],
    columns: { event_id: "hidden", activity_id: "hidden" },
  },
  {
    table: "public.event_registrations",
    resource: "event_registration",
    link: { kind: "event", column: "event_id" },
    about: [
      { column: "person_id", kind: "person" },
      { column: "event_id", kind: "event" },
    ],
    columns: {
      event_id: "hidden",
      person_id: "hidden",
      registered_by_person_id: "hidden",
      status: enumOf("status", "events.registrationStatus"),
      queued_at: "name_only",
      offer_expires_at: "name_only",
      answers: "name_only",
      // The sealed ciphertext of sensitive answers: never shown, not even as "changed".
      sensitive_answers: "hidden",
      decision_reason: text("decision_reason"),
      decided_by_person_id: "hidden",
      decided_at: "name_only",
    },
  },
  // The club.
  {
    table: "public.clubs",
    resource: "club",
    link: { kind: "club", column: "id" },
    about: [],
    columns: {
      name: text("name"),
      short_name: text("short_name"),
      slug: "name_only",
      country: "name_only",
      default_locale: "name_only",
      time_zone: text("time_zone"),
      currency: "name_only",
      organization_number: "name_only",
      federation_ids: "name_only",
      address: "name_only",
      logo: "name_only",
      status: "name_only",
      join_policy: enumOf("join_policy", "joinPolicies"),
      next_member_number: "hidden",
      owners_can_appoint_co_owners: "name_only",
      group_owners_admit_to_club: "name_only",
      access_state: "name_only",
      attendance_lock_days: num("attendance_lock_days"),
      attendance_retention_months: num("attendance_retention_months"),
      email: "name_only",
      consent_purposes: value({ list: { enum: "consentPurposes" } }, c("consent_purposes")),
      consent_reconfirm_on_new_version: "name_only",
      former_member_retention_months: num("former_member_retention_months"),
      privacy_contact_email: "name_only",
      profile_view_logging: "name_only",
    },
  },
  {
    table: "public.locations",
    resource: "location",
    link: { kind: "club", column: "club_id" },
    about: [{ column: "id", kind: "location" }],
    columns: {
      name: text("name"),
      street: text("street"),
      postal_code: "name_only",
      city: text("city"),
      latitude: "name_only",
      longitude: "name_only",
      directions: "name_only",
      archived_at: datetime("archived_at"),
      created_by_person_id: "hidden",
    },
  },
  {
    table: "public.club_phone_numbers",
    resource: "club_phone_number",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: { label: text("label"), number: text("number"), sort_order: "name_only" },
  },
  {
    table: "public.consent_texts",
    resource: "consent_text",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      purpose: enumOf("purpose", "consentPurposes"),
      version: num("version"),
      texts: "name_only",
      published_by_person_id: "hidden",
      published_at: datetime("published_at"),
    },
  },
  {
    table: "public.club_setting_decisions",
    resource: "club_setting_decision",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      body: "name_only",
      decided_on: date("decided_on"),
      reference: text("reference"),
      effective_from: date("effective_from"),
      settings: "name_only",
      applied_at: "name_only",
      recorded_by_person_id: "hidden",
      recorded_at: "hidden",
    },
  },
  {
    table: "public.club_privacy_policies",
    resource: "club_privacy_policy",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      version: num("version"),
      template_version: "name_only",
      settings: "name_only",
      decision_id: "hidden",
      effective_from: date("effective_from"),
    },
  },
  {
    table: "public.support_access_grants",
    resource: "support_access_grant",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      // The operator is named to the club's managers in their grant (ADR 0042, decision 7).
      operator_person_id: person("operator_person_id"),
      granted_by_person_id: "hidden",
      reason: text("reason"),
      expires_at: datetime("expires_at"),
      revoked_at: datetime("revoked_at"),
      revoked_by_person_id: "hidden",
    },
  },
  // Club administration (the club-wide view only).
  {
    table: "public.invitations",
    resource: "invitation",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      kind: enumOf("kind", "invitationKinds"),
      email: "name_only",
      token_hash: "hidden",
      role_preset: text("role_preset"),
      group_id: ref("group_id", "group"),
      expires_at: datetime("expires_at"),
      max_uses: "name_only",
      uses: "name_only",
      created_by_person_id: "hidden",
      accepted_by_person_id: "hidden",
      accepted_at: "name_only",
      revoked_at: datetime("revoked_at"),
    },
  },
  {
    table: "public.invitation_acceptances",
    resource: "invitation_acceptance",
    link: { kind: "person", column: "person_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: { invitation_id: "hidden", person_id: "hidden", accepted_at: datetime("accepted_at") },
  },
  {
    table: "public.member_exports",
    resource: "member_export",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      requested_by_person_id: "hidden",
      status: enumOf("status", "memberExports.status"),
      filter: "name_only",
      columns: "name_only",
      include_protected: bool("include_protected"),
      row_count: num("row_count"),
      object_key: "hidden",
      expires_at: datetime("expires_at"),
      error_code: "name_only",
    },
  },
  {
    table: "public.member_imports",
    resource: "member_import",
    link: { kind: "club", column: "club_id" },
    about: [],
    columns: {
      created_by_person_id: "hidden",
      status: enumOf("status", "memberImport.status"),
      source_format: "name_only",
      detected_source: "name_only",
      columns: "hidden",
      column_map: "name_only",
      options: "name_only",
      counts: "hidden",
      object_key: "hidden",
      error_code: "name_only",
      confirmed_by_person_id: "hidden",
      confirmed_at: datetime("confirmed_at"),
      finished_at: "name_only",
      purged_at: "name_only",
    },
  },
  {
    table: "public.club_manager_handovers",
    resource: "club_manager_handover",
    link: { kind: "club", column: "club_id" },
    about: [
      { column: "from_person_id", kind: "person" },
      { column: "to_person_id", kind: "person" },
    ],
    columns: {
      from_person_id: "hidden",
      to_person_id: "hidden",
      status: enumOf("status", STATUS),
      expires_at: datetime("expires_at"),
      decided_at: "name_only",
    },
  },
  {
    table: "public.club_manager_reassignments",
    resource: "club_manager_reassignment",
    link: { kind: "club", column: "club_id" },
    about: [{ column: "person_id", kind: "person" }],
    columns: {
      person_id: "hidden",
      // Operators are never named (ADR 0042, decision 7).
      operator_person_id: "hidden",
      reason: "name_only",
    },
  },
];

/** History-enabled tables no panel or club-wide view shows, with the reason. */
export const NEVER_SHOWN: Readonly<Record<string, string>> = {
  "billing.*": "billing is operator bookkeeping; clubs see their subscription on its own page",
  "public.accounts":
    "login data (email, identity provider); never shown to clubs; the person gets it in the data export",
  "public.account_invitations": "login invitations (email, token); global, never shown to clubs",
  "public.guardian_invitations":
    "invitations by email with a token; the guardianship they create is shown",
  "public.club_creation_requests": "requests to the platform operators, before a club exists",
  "public.people_merges": "global merge bookkeeping; its effect shows on the merged records",
  "public.platform_operators": "the platform's operators; never shown to clubs",
  "public.push_devices": "device tokens of an account; never shown to clubs",
  "public.notifications": "a person's inbox (inserts are not recorded); never shown to clubs",
  "public.data_exports": "a person's own requests for their data (global, ADR 0041)",
  "public.erasure_requests": "a person's own deletion requests (global, ADR 0041)",
  "public.calendar_feeds":
    "a person's own calendar subscriptions (global, P1.11); never shown to clubs",
  // P1.15 A1: every club has the built-in template's roles; part A2 makes them
  // editable and adds the role's history panel (with a policy here).
  "public.roles": "a club's roles, not editable before P1.15 part A2 (role history panel)",
  "public.role_permissions": "a role's permissions, shown with the role from P1.15 part A2",
  "public.club_types":
    "the club types' catalogue (P1.15 B): global, operators only; changes are in the audit log (club_type.*)",
  "public.club_type_roles": "a club type's template roles (P1.15 B): with the type",
  "public.club_type_role_permissions": "a template role's permissions (P1.15 B): with the type",
  "public.invitation_groups":
    "an invitation's groups and roles (P1.15 A4): shown with the invitation in the invitations list",
  "public.administrator_suspensions":
    "the two-person rule's requests (P1.15 A3): on the club's administrators page and in the audit log (administrator.*)",
  // Chat (P2.1, ADR 0047): a chat shows its own record (members and why,
  // system messages, every earlier text of an edit); membership changes by
  // others, joins and hides are in the audit log (chat.*). Message texts
  // never appear in a history view.
  "public.chats": "a chat's name and state: on the chat's page and in the audit log (chat.*)",
  "public.chat_groups": "the groups a chat was made for: on the chat's page",
  "public.chat_members":
    "who is in a chat and why: on the chat's page (everyone in it sees it, ADR 0047) and in the audit log",
  "public.chat_messages":
    "messages (texts redacted in history): the chat itself is the record; hiding is in the audit log",
  "public.chat_message_versions":
    "the earlier texts of edited messages: shown with the message to the chat's members",
  "public.chat_message_attachments": "prepared for files on messages; unused (P2.1)",
  "public.chat_reactions": "reactions: shown with the message to the chat's members",
  // Child safety (P2.1 part B): only the club's safeguarding officers see a
  // case, on its own page; every step (and every read) is in the audit log.
  "public.chat_reports":
    "safeguarding reports: on the case page for the club's safeguarding officers and in the audit log (chat.report.*)",
  "public.chat_report_reads":
    "the two-person rule's reads of a reported chat: on the case page and in the audit log",
  "public.chat_mutes":
    "who may not write in the club's chats: on the safeguarding page and in the audit log (chat.member.muted)",
};

const byTable = new Map(HISTORY_POLICY.map((p) => [p.table, p]));
const byResource = new Map(HISTORY_POLICY.map((p) => [p.resource, p]));

export const policyOfTable = (table: string): TablePolicy | undefined => byTable.get(table);
export const policyOfResource = (resource: HistoryResource): TablePolicy | undefined =>
  byResource.get(resource);

export function isNeverShown(table: string): boolean {
  const [schema] = table.split(".");
  return table in NEVER_SHOWN || `${schema}.*` in NEVER_SHOWN;
}

/** How a column is shown; columns the policy does not list are name_only. */
export function ruleOf(policy: TablePolicy, column: string): ColumnRule {
  if ((ALWAYS_HIDDEN as readonly string[]).includes(column)) return "hidden";
  return policy.columns[column] ?? "name_only";
}

/** Label keys of every value column, for the audit log's changed fields (first wins). */
export const FIELD_LABELS: ReadonlyMap<string, string> = (() => {
  const labels = new Map<string, string>();
  for (const p of HISTORY_POLICY) {
    for (const [column, rule] of Object.entries(p.columns)) {
      if (typeof rule === "object" && !labels.has(column)) labels.set(column, rule.label);
    }
  }
  return labels;
})();

/** Every message key the policy uses (labels and enum prefixes), for the catalogue test. */
export function policyMessageKeys(): { labels: string[]; enums: string[] } {
  const labels = new Set<string>();
  const enums = new Set<string>();
  const addFormat = (f: ValueFormat) => {
    if (typeof f === "object" && "enum" in f) enums.add(f.enum);
    if (typeof f === "object" && "list" in f && typeof f.list === "object") enums.add(f.list.enum);
  };
  for (const p of HISTORY_POLICY) {
    for (const rule of Object.values(p.columns)) {
      if (typeof rule !== "object") continue;
      labels.add(rule.label);
      if (rule.kind === "value" || rule.kind === "shared") addFormat(rule.format);
    }
  }
  return { labels: [...labels].sort(), enums: [...enums].sort() };
}
