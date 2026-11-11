// SPDX-License-Identifier: AGPL-3.0-only
// A person's active relationships across all clubs (ADR 0006), loaded in one
// query and cached in Valkey. The Actor wraps it with the helpers policies
// use. Group ownership includes child groups: helpers take the group's
// ancestor chain, which resource loaders read together with the group.
//
// Roles (P1.15, ADR 0046): every club role and group membership carries its
// role's permissions; policies ask `holds(permission, club or group)`, never
// a role or function name.

import {
  type ClubRole,
  type GroupFunction,
  type GuardianshipKind,
  type GuardianshipRight,
  type MembershipStatus,
  type MembershipType,
  PERMISSION_CATALOGUE,
  type RolePermission,
} from "@clubadmin/shared";

/** A club role held by the person, with the role's permissions. */
export interface RoleAssignment {
  clubId: string;
  roleId: string | null;
  /** The template key (the old API field; A2 makes it optional). */
  role: ClubRole;
  permissions: RolePermission[];
}

/** A group role (membership) held by the person, with the role's permissions. */
export interface GroupAssignment {
  clubId: string;
  groupId: string;
  roleId: string | null;
  /** The template key (the old API field; A2 makes it optional). */
  function: GroupFunction;
  permissions: RolePermission[];
}

export interface RelationshipSet {
  personId: string;
  /** Platform operator: no club access without a support grant. */
  operator: boolean;
  /** Open club memberships (valid_to IS NULL), any status. */
  memberships: { clubId: string; status: MembershipStatus; membershipType: MembershipType }[];
  roles: RoleAssignment[];
  /** Open group memberships; one entry per role. */
  groups: GroupAssignment[];
  /** Groups the person owns directly; ownership of a parent includes its children. */
  ownedGroups: { clubId: string; groupId: string }[];
  employments: { clubId: string; startsOn: string; endsOn: string | null }[];
  /** Unrevoked support grants (operators); expiry is checked when used. */
  supportGrants: { clubId: string; expiresAt: string }[];
  /** Active guardianships where the person is the guardian. */
  wards: { personId: string; kind: GuardianshipKind; rights: GuardianshipRight[] }[];
  /** Active guardianships where the person is the ward. */
  guardians: { personId: string; kind: GuardianshipKind }[];
  /** The wards' open club memberships. */
  wardMemberships: {
    personId: string;
    clubId: string;
    status: MembershipStatus;
    membershipType: MembershipType;
  }[];
  /** The wards' open group memberships. */
  wardGroups: (GroupAssignment & { personId: string })[];
  /** The version the set was read at (Valkey; not cached in the set itself). */
  version?: string;
}

/** Where a permission is asked for: a club (its ID) or a group of it. */
export type PermissionTarget =
  string | { clubId: string; groupId: string; ancestorIds?: readonly string[] };

/** A group with its ancestors (nearest first), as loaded with the group. */
export interface GroupRef {
  clubId: string;
  groupId: string;
  ancestorIds: readonly string[];
}

const MEMBER_STATUSES: readonly MembershipStatus[] = ["active", "paused"];

const today = (now: Date) => now.toISOString().slice(0, 10);

export interface ActorOptions {
  /** The logged-in person (the guardian when acting on behalf of a ward). */
  principalPersonId: string;
  /** Logged in with a second factor. */
  mfa: boolean;
  now?: () => Date;
}

/**
 * Who a policy evaluates. Normally the logged-in person; when a guardian acts
 * on behalf of a ward (X-On-Behalf-Of), the ward, limited to the ward's
 * memberships: a guardian never exercises a ward's roles, ownerships,
 * leader functions or employments.
 */
export class Actor {
  /** Whose relationships count (the ward when acting on behalf). */
  readonly personId: string;
  readonly principalPersonId: string;
  /** The ward's ID when a guardian acts on their behalf. */
  readonly onBehalfOf: string | null;
  readonly mfa: boolean;
  readonly relationships: RelationshipSet;
  private readonly now: () => Date;
  private readonly owned: Set<string>;
  /** Permissions held through club roles, per club. */
  private readonly clubPermissions: Map<string, Set<RolePermission>>;
  /** Permissions held through group roles, per group. */
  private readonly groupPermissions: Map<string, Set<RolePermission>>;

  private constructor(
    relationships: RelationshipSet,
    onBehalfOf: string | null,
    options: ActorOptions,
  ) {
    this.relationships = relationships;
    this.personId = relationships.personId;
    this.principalPersonId = options.principalPersonId;
    this.onBehalfOf = onBehalfOf;
    this.mfa = options.mfa;
    this.now = options.now ?? (() => new Date());
    this.owned = new Set(relationships.ownedGroups.map((o) => o.groupId));
    this.clubPermissions = new Map();
    for (const r of relationships.roles) {
      const set = this.clubPermissions.get(r.clubId) ?? new Set<RolePermission>();
      for (const p of r.permissions) set.add(p);
      this.clubPermissions.set(r.clubId, set);
    }
    this.groupPermissions = new Map();
    for (const g of relationships.groups) {
      const set = this.groupPermissions.get(g.groupId) ?? new Set<RolePermission>();
      for (const p of g.permissions) set.add(p);
      this.groupPermissions.set(g.groupId, set);
    }
  }

  static of(relationships: RelationshipSet, options: ActorOptions): Actor {
    return new Actor(relationships, null, options);
  }

  /**
   * The ward as seen through the guardian's relationship set, or null if the
   * guardian may not act for them (needs the act_on_behalf right).
   */
  static onBehalfOf(
    guardian: RelationshipSet,
    wardId: string,
    options: ActorOptions,
  ): Actor | null {
    const ward = guardian.wards.find((w) => w.personId === wardId);
    if (!ward?.rights.includes("act_on_behalf")) return null;
    return new Actor(
      {
        personId: wardId,
        operator: false,
        memberships: guardian.wardMemberships
          .filter((m) => m.personId === wardId)
          .map(({ clubId, status, membershipType }) => ({ clubId, status, membershipType })),
        roles: [],
        // The ward takes part in their groups; a guardian never exercises
        // the ward's other group permissions (e.g. a leader role).
        groups: guardian.wardGroups
          .filter((g) => g.personId === wardId && g.permissions.includes("group.participate"))
          .map(({ clubId, groupId, roleId, function: fn }) => ({
            clubId,
            groupId,
            roleId,
            function: fn,
            permissions: ["group.participate" as const],
          })),
        ownedGroups: [],
        employments: [],
        supportGrants: [],
        wards: [],
        guardians: [],
        wardMemberships: [],
        wardGroups: [],
      },
      wardId,
      options,
    );
  }

  isSelf(personId: string): boolean {
    return personId === this.personId;
  }

  isOperator(): boolean {
    return this.relationships.operator;
  }

  /** Active or paused member of the club. */
  isClubMember(clubId: string): boolean {
    return this.relationships.memberships.some(
      (m) => m.clubId === clubId && MEMBER_STATUSES.includes(m.status),
    );
  }

  /**
   * Whether the actor holds a permission through a role (P1.15): in a club
   * (club roles), or in a group (club roles of its club, roles held in the
   * group, and in a parent group for permissions that are inherited).
   */
  holds(permission: RolePermission, target: PermissionTarget): boolean {
    if (typeof target === "string") {
      return this.clubPermissions.get(target)?.has(permission) ?? false;
    }
    if (this.clubPermissions.get(target.clubId)?.has(permission)) return true;
    if (this.groupPermissions.get(target.groupId)?.has(permission)) return true;
    const entry = PERMISSION_CATALOGUE[permission];
    return (
      entry.kind === "role" &&
      entry.inherits === true &&
      (target.ancestorIds ?? []).some((id) => this.groupPermissions.get(id)?.has(permission))
    );
  }

  /** Holds the permission through a role held in some group of the club. */
  holdsInAnyGroup(permission: RolePermission, clubId: string): boolean {
    return this.relationships.groups.some(
      (g) => g.clubId === clubId && g.permissions.includes(permission),
    );
  }

  /** Any club role (board, manager, registrar, ...). */
  hasAnyClubRole(clubId: string): boolean {
    return this.relationships.roles.some((r) => r.clubId === clubId);
  }

  isEmployee(clubId: string): boolean {
    const day = today(this.now());
    return this.relationships.employments.some(
      (e) => e.clubId === clubId && e.startsOn <= day && (e.endsOn === null || e.endsOn >= day),
    );
  }

  /** Unexpired support access granted by the club; operators must use a second factor. */
  hasSupportAccess(clubId: string): boolean {
    if (!this.relationships.operator || !this.mfa) return false;
    const now = this.now().getTime();
    return this.relationships.supportGrants.some(
      (g) => g.clubId === clubId && Date.parse(g.expiresAt) > now,
    );
  }

  /** Guardian of the person, with the right if given (relatives hold only some rights). */
  isGuardianOf(personId: string, right?: GuardianshipRight): boolean {
    return this.relationships.wards.some(
      (w) => w.personId === personId && (right === undefined || w.rights.includes(right)),
    );
  }

  /**
   * Parent or legal guardian of the person, with the right to act for them
   * (not a relative or contact person, even one given that right).
   */
  isFullGuardianOf(personId: string): boolean {
    return this.relationships.wards.some(
      (w) =>
        w.personId === personId &&
        (w.kind === "parent" || w.kind === "legal_guardian") &&
        w.rights.includes("act_on_behalf"),
    );
  }

  /** Guardian (with the right) of an active or paused member of the club. */
  isGuardianOfClubMember(clubId: string, right?: GuardianshipRight): boolean {
    return this.relationships.wardMemberships.some(
      (m) =>
        m.clubId === clubId &&
        MEMBER_STATUSES.includes(m.status) &&
        this.isGuardianOf(m.personId, right),
    );
  }

  /**
   * Any current relationship with the club (member, role, employment, support
   * access, guardian of a member). Without one, the club and everything in it
   * does not exist for the actor (404).
   */
  hasClubRelationship(clubId: string): boolean {
    return (
      this.isClubMember(clubId) ||
      this.hasAnyClubRole(clubId) ||
      this.isEmployee(clubId) ||
      this.hasSupportAccess(clubId) ||
      this.isGuardianOfClubMember(clubId)
    );
  }

  /** Owner of the group or of one of its ancestors. */
  ownsGroup(group: GroupRef): boolean {
    return this.owned.has(group.groupId) || group.ancestorIds.some((id) => this.owned.has(id));
  }

  /** In the group with any role. */
  isGroupMember(groupId: string): boolean {
    return this.groupPermissions.has(groupId);
  }

  /** Owns at least one group of the club. */
  ownsAnyGroup(clubId: string): boolean {
    return this.relationships.ownedGroups.some((o) => o.clubId === clubId);
  }

  /**
   * Owns a group of the club or plans one's activities through a group role
   * (may create group events and places, P1.6).
   */
  managesAnyGroupActivities(clubId: string): boolean {
    return (
      this.relationships.ownedGroups.some((o) => o.clubId === clubId) ||
      this.holdsInAnyGroup("group.activities.manage", clubId)
    );
  }

  /** Guardian (with the right) of someone in the group. */
  isGuardianOfGroupMember(groupId: string, right?: GuardianshipRight): boolean {
    return this.relationships.wardGroups.some(
      (g) => g.groupId === groupId && this.isGuardianOf(g.personId, right),
    );
  }

  /** IDs of the clubs the actor has any relationship with (for "my clubs"). */
  clubIds(): string[] {
    const r = this.relationships;
    return [
      ...new Set([
        ...r.memberships.map((m) => m.clubId),
        ...r.roles.map((m) => m.clubId),
        ...r.employments.filter((e) => this.isEmployee(e.clubId)).map((e) => e.clubId),
      ]),
    ];
  }
}
