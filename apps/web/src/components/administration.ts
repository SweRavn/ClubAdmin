// SPDX-License-Identifier: AGPL-3.0-only
// Which permissions make the club's "Administration" tab show (P2.7c): any
// one of them gives at least one link on the page.
export const ADMINISTRATION_PERMISSIONS: ReadonlySet<string> = new Set([
  "club.members.read",
  "club.join_requests.manage",
  "club.invitations.manage",
  "club.waitlists.read",
  "club.guardians.manage",
  "club.members.import",
  "club.roles.read",
  "club.roles.manage",
  "club.settings.update",
  "club.locations.manage",
  "club.locations.create",
  "club.duties.read",
  "club.duty_types.manage",
  "club.plugins.manage",
  "club.grants.read",
  "billing.subscription.read",
  "club.documents.manage",
  "club.audit.read",
  "club.history.read",
  "club.profile_views.read",
  "club.safeguarding.handle",
  "club.background_checks.manage",
  "club.background_checks.verify",
]);
