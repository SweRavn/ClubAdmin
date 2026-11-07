// SPDX-License-Identifier: AGPL-3.0-only
// Permission names (CLAUDE.md rule 2, ADR 0006). Every API endpoint declares
// one of these (or is public / for the logged-in person's own data); the
// authorization module (apps/api/src/modules/authorization) has exactly one
// policy per permission. docs/domain-model.md lists who has each.

export const PERMISSIONS = [
  "club.read",
  "club.settings.update",
  "club.roles.manage",
  "club.members.read",
  "club.members.manage",
  "club.members.export",
  "club.members.add",
  "club.members.import",
  "group.read",
  "group.update",
  "club.groups.create",
  "group.owners.manage",
  "group.members.read",
  "group.members.manage",
  // Waiting lists (P1.10b): the group's list; the club-wide view.
  "group.waitlist.manage",
  "club.waitlists.read",
  "group.activities.read",
  "group.activities.manage",
  "activity.read",
  "activity.manage",
  "club.activities.read",
  "club.locations.manage",
  "club.locations.create",
  "activity.respond",
  "activity.responses.read",
  "activity.attendance.manage",
  "group.attendance.read",
  "club.events.read",
  "club.events.create",
  "event.read",
  "event.manage",
  "event.register",
  "event.registrations.read",
  "event.registrations.manage",
  "person.profile.read",
  "person.profile.update",
  "person.protection.set",
  "person.guardians.read",
  "person.guardians.manage",
  "person.merge",
  "person.own_login.invite",
  "person.consents.read",
  "person.consents.manage",
  "group.consents.read",
  "club.guardians.manage",
  "ops.backup.read",
  "club.access_state.update",
  "billing.plans.read",
  "billing.subscription.read",
  "billing.subscription.manage",
  "club.create",
  "club.creation.decide",
  "club.join_requests.manage",
  "club.invitations.manage",
  "club.handover.respond",
  "club.managers.claim",
  "club.managers.reassign",
  // History and audit (P1.9, ADR 0042): club managers and registrars only.
  "person.history.read",
  "group.history.read",
  "activity.history.read",
  "event.history.read",
  "club.history.read",
  "club.audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);

/** A guardian acting for a ward sends the ward's person ID in this header (ADR 0006). */
export const ON_BEHALF_OF_HEADER = "x-on-behalf-of";
