// SPDX-License-Identifier: AGPL-3.0-only
// Club roles (domain-model.md) and club managers (ADR 0018). Invariant: a club
// always has at least one active club manager. The service checks it under the
// club row's lock (clear error); a deferred constraint trigger enforces it in
// the database for every writer.

import {
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import { type ClubRole, ClubRoleSchema } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./roles.repository.ts";

export type RoleAssignment = repo.RoleAssignmentRow;
export type Handover = repo.HandoverRow;

/** How long a hand-over proposal stays open. */
export const HANDOVER_VALID_DAYS = 14;

export class RolesService {
  private readonly db: Database;
  private readonly clubs: ClubsService;

  constructor(db: Database, clubs: ClubsService) {
    this.db = db;
    this.clubs = clubs;
  }

  assignRole(context: TenantContext, personId: string, role: ClubRole): Promise<RoleAssignment> {
    return this.db.withTenant(context, async (tx) => {
      if (role === "club_manager") await this.clubs.lockClubInTx(tx, context.clubId);
      return this.assignRoleInTx(tx, context, personId, role);
    });
  }

  async assignRoleInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    role: ClubRole,
  ): Promise<RoleAssignment> {
    parseInput(ClubRoleSchema, role);
    let assignment: RoleAssignment;
    try {
      assignment = await repo.insertAssignment(tx, {
        clubId: context.clubId,
        personId,
        role,
        assignedByPersonId: context.personId ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error, "club_role_assignments_open_unique")) {
        throw new DomainError("role_already_assigned");
      }
      throw error;
    }
    await audit.record(tx, {
      action: "club.role.assigned",
      resourceType: "club_role_assignment",
      resourceId: assignment.id,
      changedFields: ["role"],
    });
    await outbox.publish(tx, "role.changed", { clubId: context.clubId, personId });
    return assignment;
  }

  endRole(context: TenantContext, personId: string, role: ClubRole): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      if (role === "club_manager") await this.clubs.lockClubInTx(tx, context.clubId);
      const assignment = await repo.findActiveAssignment(tx, context.clubId, personId, role);
      if (!assignment) throw new DomainError("not_found");
      await this.endAssignmentInTx(tx, context, assignment);
    });
  }

  /** Ends every active role of a person in the club (leaving the club). */
  async endAllRolesInTx(tx: Tx, context: TenantContext, personId: string): Promise<void> {
    const assignments = await repo.activeAssignmentsOfPerson(tx, context.clubId, personId);
    if (assignments.some((a) => a.role === "club_manager")) {
      await this.clubs.lockClubInTx(tx, context.clubId);
    }
    for (const assignment of assignments) await this.endAssignmentInTx(tx, context, assignment);
  }

  private async endAssignmentInTx(
    tx: Tx,
    context: TenantContext,
    assignment: RoleAssignment,
  ): Promise<void> {
    if (assignment.role === "club_manager") {
      // The caller holds the club row lock, so the count cannot change under us.
      const managers = await repo.activeHolders(tx, context.clubId, "club_manager");
      if (managers.length <= 1) throw new DomainError("last_club_manager");
    }
    await repo.endAssignment(tx, assignment.id, context.personId ?? null);
    await audit.record(tx, {
      action: "club.role.ended",
      resourceType: "club_role_assignment",
      resourceId: assignment.id,
      changedFields: ["valid_to"],
    });
    await outbox.publish(tx, "role.changed", {
      clubId: context.clubId,
      personId: assignment.personId,
    });
  }

  activeManagers(context: TenantContext): Promise<string[]> {
    return this.db.withTenant(context, (tx) =>
      repo.activeHolders(tx, context.clubId, "club_manager"),
    );
  }

  /** Active role assignments in a club, without an actor (development tooling). */
  activeAssignmentsSystem(
    jobName: string,
    clubId: string,
  ): Promise<{ personId: string; role: ClubRole }[]> {
    return this.db.withSystem(jobName, { clubId }, (tx) => repo.activeAssignments(tx, clubId));
  }

  /** People currently holding the role in the club. */
  activeHolders(context: TenantContext, role: ClubRole): Promise<string[]> {
    return this.db.withTenant(context, (tx) => repo.activeHolders(tx, context.clubId, role));
  }

  activeHoldersInTx(tx: Tx, clubId: string, role: ClubRole): Promise<string[]> {
    return repo.activeHolders(tx, clubId, role);
  }

  async isActiveInTx(tx: Tx, clubId: string, personId: string, role: ClubRole): Promise<boolean> {
    return (await repo.findActiveAssignment(tx, clubId, personId, role)) !== null;
  }

  /**
   * Hand-over (ADR 0018): the acting manager proposes a successor, who must
   * accept before the proposer steps down. A new proposal replaces an open one.
   */
  proposeHandover(context: TenantContext, toPersonId: string): Promise<Handover> {
    return this.db.withTenant(context, async (tx) => {
      const from = actorPersonId(context);
      await this.clubs.lockClubInTx(tx, context.clubId);
      if (from === toPersonId) throw new DomainError("handover_invalid");
      if (!(await this.isActiveInTx(tx, context.clubId, from, "club_manager"))) {
        throw new DomainError("not_a_club_manager");
      }
      if (await this.isActiveInTx(tx, context.clubId, toPersonId, "club_manager")) {
        throw new DomainError("handover_invalid");
      }
      await repo.cancelOpenHandovers(tx, context.clubId, from);
      const handover = await repo.insertHandover(tx, {
        clubId: context.clubId,
        fromPersonId: from,
        toPersonId,
        expiresAt: new Date(Date.now() + HANDOVER_VALID_DAYS * 86_400_000),
      });
      await audit.record(tx, {
        action: "club.manager.handover.proposed",
        resourceType: "club_manager_handover",
        resourceId: handover.id,
      });
      return handover;
    });
  }

  /**
   * The successor accepts: they become manager and the proposer's manager role
   * ends, atomically. Concurrent accepts are serialised by the club row lock;
   * all but the first find the hand-over no longer open.
   */
  acceptHandover(context: TenantContext, handoverId: string): Promise<Handover> {
    return this.db.withTenant(context, async (tx) => {
      const me = actorPersonId(context);
      await this.clubs.lockClubInTx(tx, context.clubId);
      const handover = await repo.lockHandover(tx, handoverId);
      if (!handover || handover.toPersonId !== me) throw new DomainError("not_found");
      if (handover.status !== "proposed" || handover.expiresAt <= new Date()) {
        throw new DomainError("handover_invalid");
      }
      const fromAssignment = await repo.findActiveAssignment(
        tx,
        context.clubId,
        handover.fromPersonId,
        "club_manager",
      );
      if (!fromAssignment) throw new DomainError("handover_invalid");

      await this.assignRoleInTx(tx, context, me, "club_manager");
      await this.endAssignmentInTx(tx, context, fromAssignment);
      await repo.setHandoverStatus(tx, handover.id, "accepted");
      await audit.record(tx, {
        action: "club.manager.handover.accepted",
        resourceType: "club_manager_handover",
        resourceId: handover.id,
      });
      return { ...handover, status: "accepted" };
    });
  }

  declineHandover(context: TenantContext, handoverId: string): Promise<void> {
    return this.closeHandover(context, handoverId, "declined");
  }

  cancelHandover(context: TenantContext, handoverId: string): Promise<void> {
    return this.closeHandover(context, handoverId, "cancelled");
  }

  private closeHandover(
    context: TenantContext,
    handoverId: string,
    status: "declined" | "cancelled",
  ): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const me = actorPersonId(context);
      const handover = await repo.lockHandover(tx, handoverId);
      const party = status === "declined" ? handover?.toPersonId : handover?.fromPersonId;
      if (!handover || party !== me) throw new DomainError("not_found");
      if (handover.status !== "proposed") throw new DomainError("handover_invalid");
      await repo.setHandoverStatus(tx, handover.id, status);
      await audit.record(tx, {
        action:
          status === "declined"
            ? "club.manager.handover.declined"
            : "club.manager.handover.cancelled",
        resourceType: "club_manager_handover",
        resourceId: handover.id,
      });
    });
  }
}
