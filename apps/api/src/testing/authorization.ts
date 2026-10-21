// SPDX-License-Identifier: AGPL-3.0-only
// Builders for unit tests of policies and visibility: relationship sets and
// resources without a database.

import { uuidv7 } from "@clubadmin/shared";

import type { PersonGroupRow } from "../modules/authorization/authorization.repository.ts";
import type {
  ClubResource,
  GroupResource,
  PersonResource,
} from "../modules/authorization/policy.ts";
import { Actor, type RelationshipSet } from "../modules/authorization/relationship-set.ts";

export function relationships(overrides: Partial<RelationshipSet> = {}): RelationshipSet {
  return {
    personId: uuidv7(),
    operator: false,
    memberships: [],
    roles: [],
    groups: [],
    ownedGroups: [],
    employments: [],
    supportGrants: [],
    wards: [],
    guardians: [],
    wardMemberships: [],
    wardGroups: [],
    ...overrides,
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
