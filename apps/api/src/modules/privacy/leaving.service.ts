// SPDX-License-Identifier: AGPL-3.0-only
// Leaving a club yourself and stepping down from assignments (P1.8a, ADR
// 0041). A person does not leave a club with open assignments (a club
// role, a leader function or a group ownership) or unsettled invoices: they
// step down first (or the club ends them), and the treasurer settles or
// writes off the invoices. Leaving ends the membership and group
// memberships, withdraws pending join requests, waiting-list entries and
// registrations to coming events, and ends the consents, in one
// transaction. "Remove my contact details now" queues the former-member
// purge for this person and club at once.

import { ageOn } from "@clubadmin/country-packs";
import { type Database, outbox, sql, type TenantContext, type Tx } from "@clubadmin/db";
import type { Assignment, ClubRole, GroupFunction } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { EventsService } from "../events/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { JoinRequestsService } from "../joining/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { RolesService } from "../roles/index.ts";
import { ageRulesOf, type ConsentsService } from "./consents.service.ts";
import type {
  OutstandingObligation,
  OutstandingObligationsProvider,
} from "./outstanding-obligations.ts";

export interface LeaveBlocker {
  code: "roles_must_be_removed" | "outstanding_invoices";
  assignments?: Assignment[];
  count?: number;
  contactRole?: ClubRole;
}

export interface LeavePreviewData {
  clubName: string;
  formerMemberRetentionMonths: number;
  member: boolean;
  blockers: LeaveBlocker[];
}

interface Deps {
  clubs: ClubsService;
  roles: RolesService;
  groups: GroupsService;
  memberships: MembershipsService;
  joinRequests: JoinRequestsService;
  events: EventsService;
  consents: ConsentsService;
  obligations: readonly OutstandingObligationsProvider[];
}

export class LeavingService {
  private readonly db: Database;
  private readonly deps: Deps;

  constructor(db: Database, deps: Deps) {
    this.db = db;
    this.deps = deps;
  }

  /** The person's assignments in the club, with whether they may step down from each. */
  assignments(context: TenantContext, personId: string): Promise<Assignment[]> {
    return this.db.withTenant(context, (tx) => this.assignmentsInTx(tx, context.clubId, personId));
  }

  private async assignmentsInTx(tx: Tx, clubId: string, personId: string): Promise<Assignment[]> {
    const roles = await this.deps.roles.activeRolesOfPersonInTx(tx, clubId, personId);
    const functions = await this.deps.memberships.leaderFunctionsOfPersonInTx(tx, clubId, personId);
    const owned = await this.deps.groups.ownershipsOfPersonInTx(tx, clubId, personId);
    const groupIds = [...new Set([...functions, ...owned].map((g) => g.groupId))];
    const names = new Map(
      (await this.deps.groups.findGroupsInTx(tx, groupIds)).map((g) => [g.id, g.name]),
    );
    const managers = roles.some((r) => r.role === "club_manager")
      ? await this.deps.roles.activeHoldersInTx(tx, clubId, "club_manager")
      : [];
    return [
      ...roles.map((r): Assignment => ({
        id: r.id,
        kind: "role",
        role: r.role,
        blockedBy: r.role === "club_manager" && managers.length <= 1 ? "last_club_manager" : null,
      })),
      ...functions.map((f): Assignment => ({
        id: f.id,
        kind: "group_function",
        groupId: f.groupId,
        groupName: names.get(f.groupId) ?? "",
        function: f.function satisfies GroupFunction,
        blockedBy: null,
      })),
      ...owned.map((o): Assignment => ({
        id: o.id,
        kind: "group_owner",
        groupId: o.groupId,
        groupName: names.get(o.groupId) ?? "",
        blockedBy: null,
      })),
    ];
  }

  private async obligationsInTx(
    tx: Tx,
    clubId: string,
    personId: string,
  ): Promise<OutstandingObligation | null> {
    let count = 0;
    // eslint-disable-next-line clubadmin/no-role-names -- a label ("ask the treasurer"), not a decision
    let contactRole: ClubRole = "treasurer";
    for (const provider of this.deps.obligations) {
      const found = await provider.forPerson(tx, clubId, personId);
      if (found && found.count > 0) {
        count += found.count;
        contactRole = found.contactRole;
      }
    }
    return count > 0 ? { count, contactRole } : null;
  }

  private async blockersInTx(tx: Tx, clubId: string, personId: string): Promise<LeaveBlocker[]> {
    const blockers: LeaveBlocker[] = [];
    const assignments = await this.assignmentsInTx(tx, clubId, personId);
    if (assignments.length > 0) blockers.push({ code: "roles_must_be_removed", assignments });
    const owed = await this.obligationsInTx(tx, clubId, personId);
    if (owed) {
      blockers.push({
        code: "outstanding_invoices",
        count: owed.count,
        contactRole: owed.contactRole,
      });
    }
    return blockers;
  }

  /** What leaving would end, what the club keeps, and what must be settled first. */
  preview(context: TenantContext, personId: string): Promise<LeavePreviewData> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const membership = await this.deps.memberships.openMembershipInTx(
        tx,
        context.clubId,
        personId,
      );
      return {
        clubName: club.name,
        formerMemberRetentionMonths: club.formerMemberRetentionMonths,
        member: membership !== null,
        blockers: await this.blockersInTx(tx, context.clubId, personId),
      };
    });
  }

  /**
   * The person leaves the club (themselves, or a full guardian for a
   * minor). Refused while blockers remain (the first blocker's code).
   */
  leave(context: TenantContext, personId: string, options: { removeNow: boolean }): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      await this.deps.clubs.lockClubInTx(tx, context.clubId);
      const [blocker] = await this.blockersInTx(tx, context.clubId, personId);
      if (blocker) throw new DomainError(blocker.code);
      const left = await this.deps.memberships.leaveClubInTx(tx, context, personId);
      if (!left) throw new DomainError("not_a_member");
      await this.deps.joinRequests.withdrawPendingInTx(tx, context, personId);
      await this.deps.groups.withdrawWaitlistEntriesOfPersonInTx(tx, context, personId);
      await this.deps.events.cancelComingRegistrationsOfPersonInTx(tx, context, personId);
      await this.deps.consents.revokeForLeavingInTx(tx, context, personId);
      await outbox.publish(tx, "membership.left", { clubId: context.clubId, personId });
      if (options.removeNow) {
        await tx.execute(sql`SELECT app.request_club_data_purge(${personId})`);
      }
    });
  }

  /**
   * The person leaves the club because their data is being erased (P1.8b):
   * in the erasure job's system transaction for the club, after it checked
   * that no blockers remain. Ends what leaving ends; the managers are told.
   */
  async leaveForErasureInTx(tx: Tx, clubId: string, personId: string): Promise<boolean> {
    const context: TenantContext = { actorKind: "anonymous", personId: null, clubId };
    // An erasure may leave the club with fewer than two administrators (P1.15
    // A3): only this SECURITY DEFINER function sets the exception, and only
    // for a person in an erasure request the job is running.
    await tx.execute(
      sql`SELECT app.allow_fewer_administrators_for_erasure(${clubId}, ${personId})`,
    );
    const left = await this.deps.memberships.leaveClubInTx(tx, context, personId);
    await this.deps.joinRequests.withdrawPendingInTx(tx, context, personId);
    await this.deps.groups.withdrawWaitlistEntriesOfPersonInTx(tx, context, personId);
    await this.deps.events.cancelComingRegistrationsOfPersonInTx(tx, context, personId);
    await this.deps.consents.revokeForLeavingInTx(tx, context, personId);
    if (left) await outbox.publish(tx, "membership.left", { clubId, personId });
    return left;
  }

  /** Whether the person is under the club's country pack adult age (a minor leaves through a guardian). */
  isMinor(context: TenantContext, personId: string): Promise<boolean> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const { rows } = await tx.execute<{ birth_date: string | null }>(
        sql`SELECT birth_date::text AS birth_date FROM public.people WHERE id = ${personId}`,
      );
      const birthDate = rows[0]?.birth_date;
      return birthDate ? ageOn(birthDate) < ageRulesOf(club.country).adultAge : false;
    });
  }

  /** Steps down from one assignment (the person, or a full guardian for a ward). */
  stepDown(context: TenantContext, personId: string, assignmentId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const assignment = (await this.assignmentsInTx(tx, context.clubId, personId)).find(
        (a) => a.id === assignmentId,
      );
      if (!assignment) throw new DomainError("not_found");
      if (assignment.blockedBy) throw new DomainError(assignment.blockedBy);
      const ended =
        assignment.kind === "role"
          ? await this.deps.roles.endRoleOfPersonInTx(tx, context, personId, assignmentId)
          : assignment.kind === "group_function"
            ? await this.deps.memberships.endGroupMembershipOfPersonInTx(
                tx,
                context,
                personId,
                assignmentId,
              )
            : await this.deps.groups.endOwnershipOfPersonInTx(tx, context, personId, assignmentId);
      if (!ended) throw new DomainError("not_found");
      await outbox.publish(tx, "assignment.ended", {
        clubId: context.clubId,
        personId,
        kind: assignment.kind,
        ...(assignment.groupId ? { groupId: assignment.groupId } : {}),
      });
    });
  }
}
