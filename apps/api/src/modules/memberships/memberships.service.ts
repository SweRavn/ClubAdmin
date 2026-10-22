// SPDX-License-Identifier: AGPL-3.0-only
// Club memberships and group memberships with functions. Memberships end by
// setting valid_to; they are never deleted (needed for LOK-stöd, annual
// reports and history).

import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type GroupFunction,
  GroupFunctionSchema,
  type MembershipType,
  MembershipTypeSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { parseInput } from "../../platform/domain/run.ts";
import type { ClubProfilesService } from "../club-profiles/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { RolesService } from "../roles/index.ts";
import * as repo from "./memberships.repository.ts";

export type ClubMembership = repo.ClubMembershipRow;
export type GroupMembership = repo.GroupMembershipRow;
export type { GroupMember } from "./memberships.repository.ts";

export interface MyClubsAndGroups {
  clubs: {
    clubId: string;
    membershipId: string;
    status: ClubMembership["status"];
    name: string;
    country: string;
  }[];
  groups: {
    clubId: string;
    groupId: string;
    function: GroupFunction;
    name: string;
    kind: string;
  }[];
}

export class MembershipsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly profiles: ClubProfilesService;
  private readonly groups: GroupsService;
  private readonly roles: RolesService;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      profiles: ClubProfilesService;
      groups: GroupsService;
      roles: RolesService;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.profiles = deps.profiles;
    this.groups = deps.groups;
    this.roles = deps.roles;
  }

  /**
   * Immediate self-service join (the person, or a guardian for a child) of a
   * club with join_policy = open (ADR 0018). Other clubs decide on a join
   * request (joining module, P1.1) or invite; this refuses them.
   */
  joinClub(
    context: TenantContext,
    personId: string,
    options: { membershipType?: MembershipType } = {},
  ): Promise<ClubMembership> {
    return this.db.withTenant(context, (tx) =>
      this.joinOpenClubInTx(tx, context, personId, options.membershipType),
    );
  }

  async joinOpenClubInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    membershipType?: MembershipType,
  ): Promise<ClubMembership> {
    const club = await this.clubs.getClubInTx(tx, context.clubId);
    if (club.joinPolicy !== "open" || club.status !== "active") {
      throw new DomainError("join_not_allowed");
    }
    return this.createMembershipInTx(tx, context, personId, "active", membershipType);
  }

  /** Administrative add (club manager or registrar; P0.7 authorizes): active immediately. */
  addMember(
    context: TenantContext,
    personId: string,
    options: { membershipType?: MembershipType } = {},
  ): Promise<ClubMembership> {
    return this.db.withTenant(context, (tx) =>
      this.addMemberInTx(tx, context, personId, options.membershipType),
    );
  }

  addMemberInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    membershipType?: MembershipType,
  ): Promise<ClubMembership> {
    return this.createMembershipInTx(tx, context, personId, "active", membershipType);
  }

  /**
   * Ends the person's membership (leaving the club), with their group
   * memberships, group ownerships and club roles. The last club manager
   * cannot leave (last_club_manager).
   */
  leaveClub(context: TenantContext, personId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const membership = await repo.findOpenMembership(tx, context.clubId, personId);
      if (!membership) throw new DomainError("not_a_member");
      await this.roles.endAllRolesInTx(tx, context, personId);
      const ended = await repo.endGroupMembershipsOfPerson(tx, context.clubId, personId);
      await this.groups.endOwnershipsOfPersonInTx(tx, context, personId);
      await repo.updateMembership(tx, membership.id, { status: "left", validTo: new Date() });
      await audit.record(tx, {
        action: "membership.ended",
        resourceType: "club_membership",
        resourceId: membership.id,
        changedFields: ["status", "valid_to"],
      });
      for (const id of ended) {
        await audit.record(tx, {
          action: "group.membership.ended",
          resourceType: "group_membership",
          resourceId: id,
        });
      }
      await outbox.publish(tx, "membership.changed", { clubId: context.clubId, personId });
    });
  }

  /** Adds a person to a group with a function. The person must be an active (or paused) club member. */
  addToGroup(
    context: TenantContext,
    groupId: string,
    personId: string,
    fn: GroupFunction = "member",
  ): Promise<GroupMembership> {
    return this.db.withTenant(context, (tx) =>
      this.addToGroupInTx(tx, context, groupId, personId, fn),
    );
  }

  async addToGroupInTx(
    tx: Tx,
    context: TenantContext,
    groupId: string,
    personId: string,
    fn: GroupFunction = "member",
  ): Promise<GroupMembership> {
    {
      parseInput(GroupFunctionSchema, fn);
      const group = await this.groups.getGroupInTx(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      const membership = await repo.findOpenMembership(tx, context.clubId, personId);
      if (!membership || (membership.status !== "active" && membership.status !== "paused")) {
        throw new DomainError("not_a_member");
      }
      let row: GroupMembership;
      try {
        row = await repo.insertGroupMembership(tx, {
          clubId: context.clubId,
          groupId,
          personId,
          function: fn,
        });
      } catch (error) {
        if (isUniqueViolation(error, "group_memberships_open_unique"))
          throw new DomainError("already_in_group");
        throw error;
      }
      await audit.record(tx, {
        action: "group.membership.created",
        resourceType: "group_membership",
        resourceId: row.id,
        changedFields: ["function"],
      });
      await outbox.publish(tx, "membership.changed", { clubId: context.clubId, personId });
      return row;
    }
  }

  endGroupMembership(context: TenantContext, groupMembershipId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findGroupMembership(tx, groupMembershipId);
      if (!row) throw new DomainError("not_found");
      if (row.validTo) return;
      await repo.endGroupMembership(tx, row.id);
      await audit.record(tx, {
        action: "group.membership.ended",
        resourceType: "group_membership",
        resourceId: row.id,
        changedFields: ["valid_to"],
      });
      await outbox.publish(tx, "membership.changed", {
        clubId: context.clubId,
        personId: row.personId,
      });
    });
  }

  /** Active members of a group with their functions (IDs only; names go through PersonVisibility, P0.7). */
  groupMembers(context: TenantContext, groupId: string): Promise<repo.GroupMember[]> {
    return this.db.withTenant(context, (tx) => repo.groupMembersQuery(tx, context.clubId, groupId));
  }

  /**
   * A page of the group's roster (IDs and functions; names go through the
   * PersonPresenter). Protected members are left out by the database unless
   * the context is viewerPrivileged (set by the authorization module).
   */
  groupMembersPage(
    context: TenantContext,
    groupId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{
    items: { personId: string; functions: GroupFunction[] }[];
    nextCursor: string | null;
    totalCount: number;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const result = await repo.groupMembersPage(tx, context.clubId, groupId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      if (!result.cursorFound) throw new DomainError("invalid_cursor");
      const items = result.items.slice(0, page.limit);
      return {
        items,
        nextCursor: result.items.length > page.limit ? items.at(-1)!.personId : null,
        totalCount: result.totalCount,
      };
    });
  }

  /** The person's (or ward's) clubs and groups across clubs, through the own-relationships policies. */
  myClubsAndGroups(context: ActorContext, personId: string): Promise<MyClubsAndGroups> {
    return this.db.withActor(context, async (tx) => {
      const memberships = await repo.clubsOfPersonQuery(tx, personId);
      const groupMemberships = await repo.groupsOfPersonQuery(tx, personId);
      const clubs = new Map(
        (
          await this.clubs.findClubsInTx(
            tx,
            memberships.map((m) => m.clubId),
          )
        ).map((c) => [c.id, c]),
      );
      const groups = new Map(
        (
          await this.groups.findGroupsInTx(tx, [...new Set(groupMemberships.map((g) => g.groupId))])
        ).map((g) => [g.id, g]),
      );
      return {
        clubs: memberships.flatMap((m) => {
          const club = clubs.get(m.clubId);
          return club ? [{ ...m, name: club.name, country: club.country }] : [];
        }),
        groups: groupMemberships.flatMap((m) => {
          const group = groups.get(m.groupId);
          return group && !group.archivedAt ? [{ ...m, name: group.name, kind: group.kind }] : [];
        }),
      };
    });
  }

  /** Active members of a club, without an actor (development tooling). */
  activeMembersSystem(jobName: string, clubId: string): Promise<string[]> {
    return this.db.withSystem(jobName, { clubId }, (tx) => repo.activeMemberIds(tx, clubId));
  }

  /** Whether the person has an open membership (any status) in the club. */
  async hasOpenMembershipInTx(tx: Tx, clubId: string, personId: string): Promise<boolean> {
    return (await repo.findOpenMembership(tx, clubId, personId)) !== null;
  }

  /** Whether the person is an active (or paused) member of the club. */
  async isMemberInTx(tx: Tx, clubId: string, personId: string): Promise<boolean> {
    const membership = await repo.findOpenMembership(tx, clubId, personId);
    return membership?.status === "active" || membership?.status === "paused";
  }

  /** Clubs where the person has an open membership (as visible to the transaction). */
  async clubIdsOfPersonInTx(tx: Tx, personId: string): Promise<string[]> {
    return (await repo.clubsOfPersonQuery(tx, personId)).map((c) => c.clubId);
  }

  private async createMembershipInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    status: "active",
    membershipType: MembershipType = "active",
  ): Promise<ClubMembership> {
    parseInput(MembershipTypeSchema, membershipType);
    if (await repo.findOpenMembership(tx, context.clubId, personId))
      throw new DomainError("already_member");
    await this.profiles.ensureProfileInTx(tx, context, personId);
    let membership: ClubMembership;
    try {
      membership = await repo.insertMembership(tx, {
        clubId: context.clubId,
        personId,
        status,
        membershipType,
      });
    } catch (error) {
      if (isUniqueViolation(error, "club_memberships_open_unique"))
        throw new DomainError("already_member");
      throw error;
    }
    await audit.record(tx, {
      action: "membership.created",
      resourceType: "club_membership",
      resourceId: membership.id,
      changedFields: ["status", "membership_type"],
    });
    await outbox.publish(tx, "membership.changed", { clubId: context.clubId, personId });
    return membership;
  }
}
