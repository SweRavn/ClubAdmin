// SPDX-License-Identifier: AGPL-3.0-only
// Builders for unit tests of policies and visibility: relationship sets and
// resources without a database.

import {
  BUILT_IN_ROLE_TEMPLATE,
  type ClubRole,
  type GroupFunction,
  uuidv7,
} from "@clubadmin/shared";

import type { PersonGroupRow } from "../modules/authorization/authorization.repository.ts";
import type {
  ClubResource,
  GroupResource,
  PersonResource,
} from "../modules/authorization/policy.ts";
import {
  Actor,
  type GroupAssignment,
  type RelationshipSet,
  type RoleAssignment,
} from "../modules/authorization/relationship-set.ts";

type Template<T extends { roleId: string | null; permissions: unknown }> = Omit<
  T,
  "roleId" | "permissions"
> &
  Partial<Pick<T, "roleId" | "permissions">>;

/**
 * Overrides of a relationship set. Roles and group memberships may be given
 * by their template key alone (`{ clubId, role: "registrar" }`): they get
 * the built-in template's permissions (P1.15), as in a club created today.
 */
export type RelationshipOverrides = Omit<
  Partial<RelationshipSet>,
  "roles" | "groups" | "wardGroups"
> & {
  roles?: Template<RoleAssignment>[];
  groups?: Template<GroupAssignment>[];
  wardGroups?: (Template<GroupAssignment> & { personId: string })[];
};

const templateRoleId = new Map<string, string>();
const roleIdOf = (clubId: string, key: string) => {
  const k = `${clubId}:${key}`;
  if (!templateRoleId.has(k)) templateRoleId.set(k, uuidv7());
  return templateRoleId.get(k)!;
};

export const withTemplate = <T extends { clubId: string; role: ClubRole }>(r: T) => ({
  roleId: roleIdOf(r.clubId, r.role),
  permissions: [...BUILT_IN_ROLE_TEMPLATE[r.role].permissions],
  ...r,
});

export const withGroupTemplate = <T extends { clubId: string; function: GroupFunction }>(g: T) => ({
  roleId: roleIdOf(g.clubId, g.function),
  permissions: [...BUILT_IN_ROLE_TEMPLATE[g.function].permissions],
  ...g,
});

export function relationships(overrides: RelationshipOverrides = {}): RelationshipSet {
  const { roles = [], groups = [], wardGroups = [], ...rest } = overrides;
  return {
    personId: uuidv7(),
    operator: false,
    memberships: [],
    ownedGroups: [],
    employments: [],
    supportGrants: [],
    wards: [],
    guardians: [],
    wardMemberships: [],
    ...rest,
    roles: roles.map(withTemplate),
    groups: groups.map(withGroupTemplate),
    wardGroups: wardGroups.map(withGroupTemplate),
  };
}

export function actorOf(set: RelationshipSet, options: { mfa?: boolean; now?: Date } = {}): Actor {
  return Actor.of(set, {
    principalPersonId: set.personId,
    mfa: options.mfa ?? false,
    ...(options.now ? { now: () => options.now! } : {}),
  });
}

export const clubResource = (clubId: string): ClubResource => ({ kind: "club", clubId });

export function groupResource(
  clubId: string,
  groupId: string,
  overrides: Partial<GroupResource> = {},
): GroupResource {
  return {
    kind: "group",
    clubId,
    groupId,
    ancestorIds: [],
    archived: false,
    ownersCanAppointCoOwners: false,
    ...overrides,
  };
}

export function personResource(
  personId: string,
  clubId: string | null,
  options: { protected?: boolean; groups?: PersonGroupRow[]; inClub?: boolean } = {},
): PersonResource {
  return {
    kind: "person",
    personId,
    clubId,
    inClub:
      clubId && options.inClub !== false
        ? {
            memberNumber: 7,
            sharedFields: [],
            protected: options.protected ?? false,
            membership: { status: "active", membershipType: "active" },
          }
        : null,
    groups: options.groups ?? [],
  };
}
