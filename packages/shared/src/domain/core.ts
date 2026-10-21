// SPDX-License-Identifier: AGPL-3.0-only
// Core domain constants (docs/domain-model.md). The database enforces the same
// lists with check constraints (packages/db/src/schema).

export const CLUB_STATUSES = ["active", "suspended", "archived"] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

/** ADR 0018. */
export const JOIN_POLICIES = ["open", "approval", "invite_only"] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

export const MEMBERSHIP_STATUSES = ["applied", "active", "paused", "left"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_TYPES = ["active", "supporting", "honorary", "family"] as const;
export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];

export const CLUB_ROLES = [
  "chair",
  "vice_chair",
  "treasurer",
  "secretary",
  "board_member",
  "deputy_board_member",
  "auditor",
  "nomination_committee",
  "club_manager",
  "registrar",
  "safeguarding_officer",
  "communications",
  "staff",
] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

export const HANDOVER_STATUSES = ["proposed", "accepted", "declined", "cancelled"] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/** ADR 0019. */
export const GROUP_KINDS = [
  "section",
  "team",
  "training_group",
  "age_group",
  "committee",
  "board",
  "volunteers",
  "other",
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const ADMISSION_MODES = ["direct", "waitlist", "closed"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export const GENDER_CATEGORIES = ["female", "male", "mixed", "open"] as const;
export type GenderCategory = (typeof GENDER_CATEGORIES)[number];

export const GROUP_FUNCTIONS = [
  "member",
  "head_coach",
  "assistant_coach",
  "team_manager",
  "physio",
  "other_leader",
] as const;
export type GroupFunction = (typeof GROUP_FUNCTIONS)[number];

export const GENDERS = ["female", "male", "other"] as const;
export type Gender = (typeof GENDERS)[number];

export const GUARDIANSHIP_KINDS = [
  "parent",
  "legal_guardian",
  "relative",
  "contact_person",
] as const;
export type GuardianshipKind = (typeof GUARDIANSHIP_KINDS)[number];

export const GUARDIANSHIP_RIGHTS = [
  "act_on_behalf",
  "receive_messages",
  "view_schedule",
  "sign_up",
  "see_medical",
] as const;
export type GuardianshipRight = (typeof GUARDIANSHIP_RIGHTS)[number];

/** Defaults per kind: parents and legal guardians get full rights, others view-only. */
export const DEFAULT_GUARDIANSHIP_RIGHTS: Record<GuardianshipKind, readonly GuardianshipRight[]> = {
  parent: GUARDIANSHIP_RIGHTS,
  legal_guardian: GUARDIANSHIP_RIGHTS,
  relative: ["view_schedule"],
  contact_person: ["view_schedule"],
};

export const GUARDIANSHIP_STATUSES = ["pending", "active", "ended"] as const;
export type GuardianshipStatus = (typeof GUARDIANSHIP_STATUSES)[number];

export const WAITLIST_STATUSES = [
  "waiting",
  "offered",
  "accepted",
  "declined",
  "expired",
  "admitted",
  "withdrawn",
  "removed",
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const INVITATION_KINDS = ["email", "link", "code"] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];

export const CONSENT_PURPOSES = [
  "photo_publication",
  "video_publication",
  "streaming",
  "marketing",
  "federation_sharing",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Person fields a club can be given access to (club_profiles.shared_fields). */
export const SHAREABLE_PERSON_FIELDS = [
  "phone",
  "address",
  "personal_identity_number",
  "gender",
] as const;
export type ShareablePersonField = (typeof SHAREABLE_PERSON_FIELDS)[number];

export const EMPLOYMENT_TYPES = ["permanent", "fixed_term", "hourly", "volunteer_stipend"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
