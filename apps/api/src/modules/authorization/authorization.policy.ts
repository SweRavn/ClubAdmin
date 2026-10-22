// SPDX-License-Identifier: AGPL-3.0-only
// The policies (docs/domain-model.md, "Effective permissions"). Exactly one
// per permission in @clubadmin/shared PERMISSIONS; the API refuses to start
// otherwise (EndpointRegistry) and the policy tests cover each with allow
// and deny cases.

import {
  type ClubRole,
  type Permission,
  PERMISSIONS,
  type RegisterAccess,
} from "@clubadmin/shared";

import { type ClubResource, definePolicy, type PersonResource, type Policy } from "./policy.ts";
import type { Actor } from "./relationship-set.ts";

/**
 * How much of a person's profile the actor sees (field filtering in the
 * profile presenter), or null if the person does not exist for them:
 * - self: the person or a guardian with act_on_behalf (everything);
 * - admin: club manager or registrar of the club;
 * - leader: owner (incl. parent groups) or leader of one of the person's groups;
 * - member: someone in one of the person's groups (or their guardian), or
 *   support access; never for a protected person (ADR 0022).
 */
export type ProfileAccess = "self" | "admin" | "leader" | "member";

export function profileAccess(actor: Actor, resource: PersonResource): ProfileAccess | null {
  const { personId, clubId, inClub, groups } = resource;
  if (actor.isSelf(personId) || actor.isGuardianOf(personId, "act_on_behalf")) return "self";
  if (!clubId || !inClub) return null;
  if (actor.hasClubRole(clubId, "club_manager", "registrar")) return "admin";
  if (
    groups.some(
      (g) =>
        actor.ownsGroup({ clubId, groupId: g.groupId, ancestorIds: g.ancestorIds }) ||
        actor.leadsGroup(g.groupId),
    )
  ) {
    return "leader";
  }
  if (inClub.protected) return null;
  if (
    groups.some(
      (g) =>
        actor.isGroupMember(g.groupId) || actor.isGuardianOfGroupMember(g.groupId, "act_on_behalf"),
    ) ||
    actor.hasSupportAccess(clubId)
  ) {
    return "member";
  }
  return null;
}

const isAdmin = (actor: Actor, clubId: string) =>
  actor.hasClubRole(clubId, "club_manager", "registrar");

/** Board roles: the limited member register (P1.2). */
export const BOARD_ROLES: readonly ClubRole[] = [
  "chair",
  "vice_chair",
  "treasurer",
  "secretary",
  "board_member",
  "deputy_board_member",
];

/**
 * How much of the member register the actor sees (P1.2), or null:
 * - full: club managers and registrars (every field, protected members marked);
 * - limited: board roles (name, member number, membership type, groups;
 *   never protected members).
 */
export function registerAccess(actor: Actor, clubId: string): RegisterAccess | null {
  if (isAdmin(actor, clubId)) return "full";
  if (actor.hasClubRole(clubId, ...BOARD_ROLES)) return "limited";
  return null;
}

export const POLICIES: readonly Policy[] = [
  definePolicy("club.read", "club", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy(
    "club.settings.update",
    "club",
    ({ actor, resource }) => actor.isClubManager(resource.clubId),
    { mfa: true },
  ),
  definePolicy(
    "club.roles.manage",
    "club",
    ({ actor, resource }) => actor.isClubManager(resource.clubId),
    { mfa: true },
  ),
  // The member register (P1.2): full for administrators, limited for the board.
  definePolicy(
    "club.members.read",
    "club",
    ({ actor, resource }) => registerAccess(actor, resource.clubId) !== null,
  ),
  // Pausing, resuming, ending and retyping memberships: registrars, and club
  // managers with a second factor.
  definePolicy(
    "club.members.manage",
    "club",
    ({ actor, resource }) => isAdmin(actor, resource.clubId),
    {
      mfa: ({ actor, resource }) => !actor.hasClubRole(resource.clubId, "registrar"),
    },
  ),
  // Exports of the register (the controller adds @RecentAuth(15)).
  definePolicy(
    "club.members.export",
    "club",
    ({ actor, resource }) => isAdmin(actor, resource.clubId),
    {
      mfa: true,
    },
  ),
  // Group structure is not personal data: anyone related to the club sees its
  // groups; archived ones only those who administer them.
  definePolicy(
    "group.read",
    "group",
    ({ actor, resource }) =>
      actor.hasClubRelationship(resource.clubId) &&
      (!resource.archived || isAdmin(actor, resource.clubId) || actor.ownsGroup(resource)),
  ),
  definePolicy(
    "group.update",
    "group",
    ({ actor, resource }) => actor.isClubManager(resource.clubId) || actor.ownsGroup(resource),
  ),
  definePolicy(
    "group.owners.manage",
    "group",
    ({ actor, resource }) =>
      actor.isClubManager(resource.clubId) ||
      (resource.ownersCanAppointCoOwners && actor.ownsGroup(resource)),
  ),
  // The roster: administrators, owners, everyone in the group, guardians of
  // its members, and support access. Protected members are filtered per
  // viewer (PersonVisibility).
  definePolicy("group.members.read", "group", ({ actor, resource }) => {
    if (isAdmin(actor, resource.clubId) || actor.ownsGroup(resource)) return true;
    if (resource.archived) return false;
    return (
      actor.isGroupMember(resource.groupId) ||
      actor.isGuardianOfGroupMember(resource.groupId, "act_on_behalf") ||
      actor.hasSupportAccess(resource.clubId)
    );
  }),
  definePolicy(
    "group.members.manage",
    "group",
    ({ actor, resource }) => actor.isClubManager(resource.clubId) || actor.ownsGroup(resource),
  ),
  definePolicy(
    "person.profile.read",
    "person",
    ({ actor, resource }) => profileAccess(actor, resource) !== null,
  ),
  definePolicy(
    "person.profile.update",
    "person",
    ({ actor, resource }) =>
      actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId, "act_on_behalf"),
  ),
  // Global flag: the person or a guardian; club flag (with clubId): a club
  // manager, with a second factor.
  definePolicy(
    "person.protection.set",
    "person",
    ({ actor, resource }) =>
      resource.clubId
        ? resource.inClub !== null && actor.isClubManager(resource.clubId)
        : actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId, "act_on_behalf"),
    { mfa: ({ resource }) => resource.clubId !== null },
  ),
  // Operator endpoints (backup status): platform operators, who are also the
  // administrators of a self-hosted installation; with a second factor.
  definePolicy("ops.backup.read", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  // Read-only and suspended clubs (P0.12): operators only, also with billing off.
  definePolicy("club.access_state.update", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Billing (routes only with BILLING_ENABLED=true): the catalogue and changes
  // for operators; a club's subscription also for its managers and treasurers.
  definePolicy("billing.plans.read", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  definePolicy(
    "billing.subscription.read",
    "club",
    ({ actor, resource }) =>
      actor.isOperator() || actor.hasClubRole(resource.clubId, "club_manager", "treasurer"),
    { mfa: ({ actor }) => actor.isOperator() },
  ),
  definePolicy("billing.subscription.manage", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Joining (P1.1, ADR 0018). Club creation follows CLUB_CREATION: anyone
  // logged in (open, approval: the service then files a request), only
  // operators (operators_only, with a second factor). The service also
  // requires a completed profile.
  definePolicy(
    "club.create",
    "platform",
    ({ actor, resource }) => resource.clubCreation !== "operators_only" || actor.isOperator(),
    { mfa: ({ resource }) => resource.clubCreation === "operators_only" },
  ),
  definePolicy("club.creation.decide", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  definePolicy("club.join_requests.manage", "club", ({ actor, resource }) =>
    isAdmin(actor, resource.clubId),
  ),
  // Role presets additionally need club.roles.manage (checked by the controller).
  definePolicy("club.invitations.manage", "club", ({ actor, resource }) =>
    isAdmin(actor, resource.clubId),
  ),
  // The successor accepts or declines, the proposer cancels (the service
  // checks which); nobody else sees the proposal.
  definePolicy(
    "club.handover.respond",
    "handover",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      (actor.isSelf(resource.toPersonId) || actor.isSelf(resource.fromPersonId)),
  ),
  // Recovery (ADR 0018): the board chair, when no manager is left (the
  // service checks that), with a second factor.
  definePolicy(
    "club.managers.claim",
    "club",
    ({ actor, resource }) => actor.hasClubRole(resource.clubId, "chair"),
    { mfa: true },
  ),
  // Recovery by an operator on the club's documented request; gives the
  // operator no access to club data.
  definePolicy("club.managers.reassign", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
];

const byPermission = new Map<Permission, Policy>(POLICIES.map((p) => [p.permission, p]));

export function policyFor(permission: Permission): Policy | undefined {
  return byPermission.get(permission);
}

/**
 * The club-level permissions (policies on the club resource) the actor holds
 * in a club, for navigation hints (GET /me/clubs). MFA requirements are not
 * applied here; the endpoints still enforce them.
 */
export function clubPermissions(actor: Actor, clubId: string): Permission[] {
  const resource: ClubResource = { kind: "club", clubId };
  return POLICIES.filter(
    (p): p is Policy<"club"> =>
      p.resource === "club" && (p as Policy<"club">).allows({ actor, resource }),
  ).map((p) => p.permission);
}

/** Permissions without exactly one policy (the startup check refuses to start). */
export function policyGaps(): string[] {
  const gaps: string[] = PERMISSIONS.filter(
    (p) => POLICIES.filter((policy) => policy.permission === p).length !== 1,
  );
  return gaps;
}
