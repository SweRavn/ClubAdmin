// SPDX-License-Identifier: AGPL-3.0-only
// The permission catalogue (P1.15, ADR 0046): what a role can contain.
//
// Every endpoint permission in PERMISSIONS is classified:
// - `role`: granted by roles. A role is held in the club or in a group;
//   `scope` says where the permission applies (a club role holding a group
//   permission has it in every group of the club). Group permissions are not
//   inherited by child groups unless `inherits` (P1.15 decision 13).
// - `derived`: decided by another permission plus relationships (e.g.
//   `activity.read` follows `group.activities.read` of the activity's groups).
// - `built_in`: never in a role; relationships alone (one's own data,
//   guardians, operators, club creation).
//
// Some capabilities are not endpoints of their own (taking part in a group,
// counting as its leader, the profile tiers, protected identity); they are
// role permissions too, so that no code outside the roles module needs a
// role name.
//
// BUILT_IN_ROLE_TEMPLATE gives today's roles (CLUB_ROLES and GROUP_FUNCTIONS
// as template keys) the permissions they had before P1.15; migration 0030
// creates every club's roles from the same table (a test compares them).

import type { ClubRole, GroupFunction } from "../domain/core.ts";
import { type Permission, PERMISSIONS } from "../permissions.ts";

/** Capabilities a role can grant that are not endpoint permissions. */
export const CAPABILITIES = [
  /** The register's details and the profile's admin tier. */
  "club.people.details",
  /** Seeing members with protected identity (ADR 0022). */
  "club.people.protected",
  /** Changing memberships without a second factor each time (registrars). */
  "club.members.routine",
  /** Seeing archived groups. */
  "club.groups.archived.read",
  /** Ending a parent's or legal guardian's guardianship recorded in the club. */
  "club.guardianships.end",
  /** Taking part in the group's activities (My schedule, answering). */
  "group.participate",
  /** Counting as a leader of the group (attendance, activities, recipients). */
  "group.lead",
  /** The profile's leader tier for the group's members. */
  "group.people.details",
  /** Managing chat channels others created in the group (P2.1: members, archiving). */
  "group.channels.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Anything a role can hold. */
export type RolePermission = Permission | Capability;

export const PERMISSION_AREAS = [
  "members",
  "groups",
  "activities",
  "events",
  "finance",
  "privacy",
  "club",
  "communication",
] as const;
export type PermissionArea = (typeof PERMISSION_AREAS)[number];

export type PermissionScope = "club" | "group";

export interface RolePermissionEntry {
  kind: "role";
  scope: PermissionScope;
  area: PermissionArea;
  /** Access to many people's personal data, protected identity, money, history or roles. */
  sensitive: boolean;
  /** Group scope: also in the child groups of a group where the role is held. */
  inherits?: boolean;
}

export type CatalogueEntry =
  RolePermissionEntry | { kind: "derived"; from: RolePermission } | { kind: "built_in" };

const role = (
  scope: PermissionScope,
  area: PermissionArea,
  sensitive = false,
): RolePermissionEntry => ({ kind: "role", scope, area, sensitive });
const derived = (from: RolePermission): CatalogueEntry => ({ kind: "derived", from });
const builtIn: CatalogueEntry = { kind: "built_in" };

export const PERMISSION_CATALOGUE: Readonly<Record<RolePermission, CatalogueEntry>> = {
  // The club
  "club.read": builtIn,
  "club.settings.update": role("club", "club"),
  "club.roles.manage": role("club", "club", true),
  "club.roles.read": role("club", "club"),
  "club.managers.claim": role("club", "club", true),
  "club.handover.respond": builtIn,
  "club.managers.reassign": builtIn,
  "club.administrators.confirm_suspension": builtIn,
  "club.administrators.extend_grace": builtIn,
  "club_types.read": builtIn,
  "club_types.manage": builtIn,
  "club.create": builtIn,
  "club.creation.decide": builtIn,
  "club.access_state.update": builtIn,
  "club.history.read": role("club", "privacy", true),
  "club.audit.read": role("club", "privacy", true),
  "club.profile_views.read": role("club", "privacy", true),
  "club.profile_views.configure": role("club", "privacy", true),
  // Members
  "club.members.read": role("club", "members", true),
  "club.people.details": role("club", "members", true),
  "club.people.protected": role("club", "privacy", true),
  "club.members.manage": role("club", "members", true),
  "club.members.routine": role("club", "members", true),
  "club.members.export": role("club", "members", true),
  "club.members.add": role("club", "members"),
  "club.members.import": role("club", "members", true),
  "club.join_requests.manage": role("club", "members"),
  "club.invitations.manage": role("club", "members"),
  "club.guardians.manage": role("club", "members", true),
  "club.guardianships.end": role("club", "members", true),
  "club.waitlists.read": role("club", "members"),
  "person.profile.read": derived("club.people.details"),
  "person.profile.update": builtIn,
  "person.protection.set": role("club", "privacy", true),
  "person.access_log.read": builtIn,
  "person.guardians.read": builtIn,
  "person.guardians.manage": builtIn,
  "person.merge": role("club", "members", true),
  "person.own_login.invite": role("club", "members"),
  "person.consents.read": role("group", "privacy", true),
  "person.consents.manage": role("club", "privacy", true),
  "person.history.read": role("club", "privacy", true),
  // Groups
  "group.read": derived("club.groups.archived.read"),
  "club.groups.archived.read": role("club", "groups"),
  "group.update": role("group", "groups"),
  "club.groups.create": role("club", "groups"),
  "group.owners.manage": role("group", "groups"),
  "group.members.read": role("group", "groups"),
  "group.members.manage": role("group", "groups"),
  "group.waitlist.manage": role("group", "groups"),
  "group.people.details": role("group", "members", true),
  "group.consents.read": role("group", "privacy"),
  "group.history.read": role("club", "privacy", true),
  "group.participate": role("group", "activities"),
  "group.lead": role("group", "activities"),
  // Activities
  "group.activities.read": role("group", "activities"),
  "group.activities.manage": role("group", "activities"),
  "activity.read": derived("group.activities.read"),
  "activity.manage": derived("group.activities.manage"),
  "club.activities.read": role("club", "activities"),
  "club.locations.manage": role("club", "activities"),
  "club.locations.create": role("club", "activities"),
  "activity.respond": derived("group.participate"),
  "activity.responses.read": role("group", "activities"),
  "activity.attendance.manage": role("group", "activities"),
  "group.attendance.read": role("group", "activities"),
  "activity.history.read": role("club", "privacy", true),
  // Events
  "club.events.read": builtIn,
  "club.events.create": role("club", "events"),
  "event.read": role("club", "events"),
  "event.manage": role("club", "events"),
  "event.register": builtIn,
  "event.registrations.read": role("club", "events"),
  "event.registrations.manage": derived("event.manage"),
  "event.history.read": role("club", "privacy", true),
  // Finance
  "billing.subscription.read": role("club", "finance"),
  "billing.subscription.change": role("club", "finance", true),
  "billing.account.manage": role("club", "finance", true),
  "billing.invoices.read": role("club", "finance"),
  "billing.plans.read": builtIn,
  "billing.subscription.manage": builtIn,
  "billing.plans.manage": builtIn,
  "billing.subscriptions.list": builtIn,
  "billing.invoices.list": builtIn,
  "billing.invoices.manage": builtIn,
  // Communication (P2.1, ADR 0047): who may read, join and write a chat is
  // decided by its members and the child-safety rules, not by roles.
  "group.channels.create": role("group", "communication"),
  "group.channels.manage": role("group", "communication"),
  "club.channels.create": role("club", "communication"),
  "club.chats.direct": builtIn,
  "chat.read": builtIn,
  "chat.join": builtIn,
  "chat.post": builtIn,
  "chat.manage": derived("group.channels.manage"),
  // Operators
  "ops.backup.read": builtIn,
};

/** Permissions a role can hold, in catalogue order. */
export const ROLE_PERMISSIONS: readonly RolePermission[] = (
  Object.keys(PERMISSION_CATALOGUE) as RolePermission[]
).filter((p) => PERMISSION_CATALOGUE[p].kind === "role");

export const isRolePermission = (value: string): value is RolePermission =>
  PERMISSION_CATALOGUE[value as RolePermission]?.kind === "role";

/** The catalogue entry of a role permission. */
export function rolePermissionEntry(permission: RolePermission): RolePermissionEntry {
  const entry = PERMISSION_CATALOGUE[permission];
  if (entry.kind !== "role") throw new Error(`${permission} is not held through roles`);
  return entry;
}

/** Endpoint permissions missing from the catalogue (a test fails on any). */
export function uncataloguedPermissions(): Permission[] {
  return PERMISSIONS.filter((p) => !(p in PERMISSION_CATALOGUE));
}

// --- The built-in template (today's roles) -----------------------------------

/**
 * Roles that cannot be deleted, and their locked permissions: the club
 * manager administers roles (ADR 0018 lock-out guard), the chair recovers a
 * club without managers.
 */
export const LOCKED_ROLES = {
  // P1.15 decision 12: the person who assigns roles finds every member and
  // sees who is protected (not their details).
  club_manager: ["club.roles.manage", "club.people.protected"],
  chair: ["club.managers.claim"],
} as const satisfies Partial<Record<ClubRole, readonly RolePermission[]>>;

const ADMIN: readonly RolePermission[] = [
  "club.people.details",
  "club.people.protected",
  "club.members.read",
  "club.members.manage",
  "club.members.export",
  "club.members.add",
  "club.members.import",
  "club.join_requests.manage",
  "club.invitations.manage",
  "club.guardians.manage",
  "club.waitlists.read",
  "club.groups.archived.read",
  "club.activities.read",
  "group.members.read",
  "group.activities.read",
  "group.attendance.read",
  "activity.attendance.manage",
  "event.read",
  "event.registrations.read",
  "person.own_login.invite",
  "person.consents.read",
  "person.consents.manage",
  "group.consents.read",
  "person.history.read",
  "group.history.read",
  "activity.history.read",
  "event.history.read",
];

const BOARD: readonly RolePermission[] = [
  "club.members.read",
  "club.activities.read",
  "club.events.create",
];

const LEADER: readonly RolePermission[] = [
  "group.lead",
  "group.people.details",
  "person.consents.read",
  "group.consents.read",
];

const PLANNER: readonly RolePermission[] = [
  ...LEADER,
  "group.activities.manage",
  "activity.responses.read",
];

/** Template roles of the built-in club type: template key → scope and permissions. */
export const BUILT_IN_ROLE_TEMPLATE: Readonly<
  Record<
    ClubRole | GroupFunction,
    { scope: PermissionScope; permissions: readonly RolePermission[] }
  >
> = {
  // P1.15 A2 (decision 2026-11-08): the club manager administers the club
  // and access, not the day-to-day work of other roles (MANAGER_SPLIT).
  club_manager: {
    scope: "club",
    permissions: [
      "club.settings.update",
      "club.roles.manage",
      "club.roles.read",
      "club.people.protected",
      "club.members.read",
      "club.join_requests.manage",
      "club.invitations.manage",
      "club.waitlists.read",
      "club.groups.archived.read",
      "club.groups.create",
      "group.update",
      "group.owners.manage",
      "group.members.read",
      "group.members.manage",
      "group.waitlist.manage",
      "group.activities.read",
      "group.activities.manage",
      "club.activities.read",
      "club.locations.manage",
      "club.locations.create",
      "club.events.create",
      "event.read",
      "event.manage",
      "person.protection.set",
      "person.merge",
      "club.guardianships.end",
      "club.history.read",
      "club.audit.read",
      "group.history.read",
      "activity.history.read",
      "event.history.read",
      "club.profile_views.read",
      "club.profile_views.configure",
      "billing.subscription.read",
      "billing.subscription.change",
      "billing.account.manage",
      "billing.invoices.read",
      "club.channels.create",
    ],
  },
  registrar: {
    scope: "club",
    permissions: [...ADMIN, "club.members.routine", "club.roles.read"],
  },
  chair: {
    scope: "club",
    permissions: [...BOARD, "club.managers.claim", "club.roles.read", "club.channels.create"],
  },
  vice_chair: { scope: "club", permissions: BOARD },
  treasurer: {
    scope: "club",
    permissions: [
      ...BOARD,
      "billing.subscription.read",
      "billing.account.manage",
      "billing.invoices.read",
    ],
  },
  secretary: { scope: "club", permissions: BOARD },
  board_member: { scope: "club", permissions: BOARD },
  deputy_board_member: { scope: "club", permissions: BOARD },
  auditor: { scope: "club", permissions: [] },
  nomination_committee: { scope: "club", permissions: [] },
  safeguarding_officer: { scope: "club", permissions: [] },
  communications: { scope: "club", permissions: [] },
  staff: { scope: "club", permissions: [] },
  // Children create channels too (P2.1, ADR 0047: visible to their guardians and leaders).
  member: { scope: "group", permissions: ["group.participate", "group.channels.create"] },
  head_coach: {
    scope: "group",
    permissions: [...PLANNER, "group.channels.create", "group.channels.manage"],
  },
  assistant_coach: { scope: "group", permissions: [...PLANNER, "group.channels.create"] },
  team_manager: { scope: "group", permissions: [...PLANNER, "group.channels.create"] },
  physio: { scope: "group", permissions: LEADER },
  other_leader: { scope: "group", permissions: [...LEADER, "activity.responses.read"] },
};

/** The permissions of a template role (by key), for tests and the seed. */
export function templatePermissions(key: ClubRole | GroupFunction): readonly RolePermission[] {
  return BUILT_IN_ROLE_TEMPLATE[key].permissions;
}

/**
 * What owning a group gives (ADR 0019; the policies' `ownsGroup`), for the
 * no-escalation rule: an owner may give roles in their group whose
 * permissions are among these (P1.15 A2). Taking part and counting as a
 * leader are not powers and never block.
 */
export const OWNER_PERMISSIONS: readonly RolePermission[] = [
  "group.update",
  "group.members.read",
  "group.members.manage",
  "group.waitlist.manage",
  "group.activities.read",
  "group.activities.manage",
  "activity.responses.read",
  "activity.attendance.manage",
  "group.attendance.read",
  "group.people.details",
  "person.consents.read",
  "group.consents.read",
  "group.channels.create",
  "group.channels.manage",
];
/**
 * Not powers over others: taking part, counting as a leader, and creating
 * chat channels (P2.1: participants, children included, create channels).
 */
export const NON_POWERS: readonly RolePermission[] = [
  "group.participate",
  "group.lead",
  "group.channels.create",
];

/**
 * The club manager's day-to-day permissions that moved to the registrar
 * (P1.15 A2, migration 0032): existing clubs' managers are told and can give
 * themselves the registrar role.
 */
export const MANAGER_SPLIT: readonly RolePermission[] = BUILT_IN_ROLE_TEMPLATE.registrar.permissions
  .filter((p) => !BUILT_IN_ROLE_TEMPLATE.club_manager.permissions.includes(p))
  .filter((p) => p !== "club.members.routine");
