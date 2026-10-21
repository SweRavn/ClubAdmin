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
   * Self-service join (the person, or a guardian for a child), following the
   * club's join_policy (ADR 0018): `open` → active, `approval` → applied,
   * `invite_only` → refused (invitations come in P1.1).
   */
  joinClub(
    context: TenantContext,
    personId: string,
    options: { membershipType?: MembershipType } = {},
  ): Promise<ClubMembership> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      if (club.joinPolicy === "invite_only" || club.status !== "active") {
        throw new DomainError("join_not_allowed");
      }
      const status = club.joinPolicy === "open" ? "active" : "applied";
      return this.createMembershipInTx(tx, context, personId, status, options.membershipType);
    });
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

  approveMembership(context: TenantContext, membershipId: string): Promise<ClubMembership> {
    return this.db.withTenant(context, async (tx) => {
      const membership = await repo.findMembership(tx, membershipId);
      if (!membership) throw new DomainError("not_found");
      if (membership.status !== "applied") throw new DomainError("invalid_input");
      await repo.updateMembership(tx, membershipId, { status: "active" });
      await audit.record(tx, {
        action: "membership.approved",
        resourceType: "club_membership",
        resourceId: membershipId,
        changedFields: ["status"],
      });
      await outbox.publish(tx, "membership.changed", {
        clubId: context.clubId,
        personId: membership.personId,
      });
      return { ...membership, status: "active" };
    });
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
    return this.db.withTenant(context, async (tx) => {
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
    });
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

  /** Clubs where the person has an open membership (as visible to the transaction). */
  async clubIdsOfPersonInTx(tx: Tx, personId: string): Promise<string[]> {
    return (await repo.clubsOfPersonQuery(tx, personId)).map((c) => c.clubId);
  }

  private async createMembershipInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    status: "active" | "applied",
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
