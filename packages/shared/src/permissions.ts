// SPDX-License-Identifier: AGPL-3.0-only
// Permission names (CLAUDE.md rule 2, ADR 0006). Every API endpoint declares
// one of these (or is public / for the logged-in person's own data); the
// authorization module (apps/api/src/modules/authorization) has exactly one
// policy per permission. docs/domain-model.md lists who has each.

export const PERMISSIONS = [
  "club.read",
  "club.settings.update",
  "club.roles.manage",
  // Club-defined roles (P1.15 A2): the roles page and who holds what.
  "club.roles.read",
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
  "person.access_log.read",
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
  "billing.subscription.change",
  "billing.account.manage",
  "billing.invoices.read",
  "billing.plans.manage",
  "billing.subscriptions.list",
  "billing.invoices.list",
  "billing.invoices.manage",
  "club.create",
  "club.creation.decide",
  "club.join_requests.manage",
  "club.invitations.manage",
  "club.handover.respond",
  "club.managers.claim",
  "club.managers.reassign",
  // At least two administrators (P1.15 A3): the two-person rule's
  // confirmation, and an operator extending a club's grace period.
  "club.administrators.confirm_suspension",
  "club.administrators.extend_grace",
  // Club types and their templates (P1.15 B): operators.
  "club_types.read",
  "club_types.manage",
  // History and audit (P1.9, ADR 0042): club managers and registrars only.
  "person.history.read",
  "group.history.read",
  "activity.history.read",
  "event.history.read",
  "club.history.read",
  "club.audit.read",
  "club.profile_views.read",
  "club.profile_views.configure",
  // Chat (P2.1, ADR 0047): channels in groups and the club, direct messages,
  // reading, writing and managing a chat (its members and rules decide).
  "group.channels.create",
  "club.channels.create",
  "club.chats.direct",
  "chat.read",
  "chat.join",
  "chat.post",
  "chat.manage",
  // Child safety (P2.1 part B, ADR 0047 rule 7): reports, safeguarding cases
  // (reading under the two-person rule), hiding reported messages, muting.
  "club.safeguarding.handle",
  // The file archive (P2.2, ADR 0049): reading follows the audiences;
  // managing the club's or a group's folders and files.
  "club.documents.read",
  "club.documents.manage",
  "group.documents.read",
  "group.documents.manage",
  "folder.read",
  "folder.manage",
  "document.read",
  "document.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);

/**
 * The caller's authorization version (P1.15 A2): it changes whenever what
 * they may do changes (a role, its permissions, a membership). Apps compare
 * it with the version they cached with and refresh their permissions.
 */
export const AUTHZ_VERSION_HEADER = "x-authz-version";

/** A guardian acting for a ward sends the ward's person ID in this header (ADR 0006). */
export const ON_BEHALF_OF_HEADER = "x-on-behalf-of";
