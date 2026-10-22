// SPDX-License-Identifier: AGPL-3.0-only
// Finding a club and asking to join it (ADR 0018, P1.1). A club with
// join_policy = open takes the applicants at once; approval clubs get a join
// request that a manager or registrar decides; invite_only clubs are not
// listed and answer "not found". A join request is the only record of an
// application: approving it creates the active membership.

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
  type ClubSearchQuery,
  type CreateJoinRequestInput,
  CreateJoinRequestSchema,
  type JoinRequestStatus,
  type MembershipType,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import * as repo from "./joining.repository.ts";

export type JoinRequest = repo.JoinRequestRow;
export type ClubListing = repo.ClubListingRow;

export class JoinRequestsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly groups: GroupsService;
  private readonly memberships: MembershipsService;
  private readonly accounts: AccountsService;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      groups: GroupsService;
      memberships: MembershipsService;
      accounts: AccountsService;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.groups = deps.groups;
    this.memberships = deps.memberships;
    this.accounts = deps.accounts;
  }

  /** Listed clubs by name, short name or city (app.search_clubs); cursor = the last club's ID. */
  search(
    context: ActorContext,
    query: ClubSearchQuery,
  ): Promise<{ items: ClubListing[]; nextCursor: string | null }> {
    return this.db.withActor(context, async (tx) => {
      const rows = await repo.searchClubs(tx, {
        q: query.q ?? null,
        country: query.country ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  /**
   * The caller asks to join for themselves and/or their wards. The caller
   * checks that each person is the actor or a ward with act_on_behalf
   * (authorization); the requester needs a verified email and a completed
   * profile.
   */
  request(
    context: TenantContext,
    input: CreateJoinRequestInput,
  ): Promise<{ personId: string; result: "member" | "pending"; joinRequestId: string | null }[]> {
    const data = parseInput(CreateJoinRequestSchema, input);
    const requester = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await this.accounts.requireReadyForClubsInTx(tx, requester);
      const club = await this.clubs.lockClubInTx(tx, context.clubId);
      if (club.status !== "active" || club.joinPolicy === "invite_only") {
        throw new DomainError("not_found");
      }
      await this.checkPreferredGroups(tx, data.preferredGroupIds);
      const results = [];
      for (const personId of [...new Set(data.personIds)]) {
        if (club.joinPolicy === "open") {
          await this.memberships.joinOpenClubInTx(tx, context, personId);
          results.push({ personId, result: "member" as const, joinRequestId: null });
          continue;
        }
        if (await this.memberships.hasOpenMembershipInTx(tx, context.clubId, personId)) {
          throw new DomainError("already_member");
        }
        let row: JoinRequest;
        try {
          row = await repo.insertJoinRequest(tx, {
            clubId: context.clubId,
            personId,
            requestedByPersonId: requester,
            message: data.message ?? null,
            preferredGroupIds: data.preferredGroupIds,
          });
        } catch (error) {
          if (isUniqueViolation(error, "join_requests_pending_unique")) {
            throw new DomainError("join_request_exists");
          }
          throw error;
        }
        await audit.record(tx, {
          action: "join_request.created",
          resourceType: "join_request",
          resourceId: row.id,
          changedFields: ["status", "message", "preferred_group_ids"],
        });
        results.push({ personId, result: "pending" as const, joinRequestId: row.id });
      }
      return results;
    });
  }

  /** The applicant (or whoever applied for them) withdraws a pending request. */
  async withdraw(context: ActorContext, joinRequestId: string): Promise<void> {
    const me = actorPersonId(context);
    // Readable through own_relationships in any club; changed in its club.
    const found = await this.db.withActor(context, async (tx) =>
      (await repo.myJoinRequests(tx, [me])).find((r) => r.id === joinRequestId),
    );
    if (!found || (found.personId !== me && found.requestedByPersonId !== me)) {
      throw new DomainError("not_found");
    }
    await this.db.withTenant({ ...context, clubId: found.clubId }, async (tx) => {
      const row = await repo.lockJoinRequest(tx, joinRequestId);
      if (!row || row.status !== "pending") throw new DomainError("invalid_input");
      await repo.decideJoinRequest(tx, row.id, { status: "withdrawn", decidedByPersonId: me });
      await audit.record(tx, {
        action: "join_request.withdrawn",
        resourceType: "join_request",
        resourceId: row.id,
        changedFields: ["status", "decided_at"],
      });
    });
  }

  /** The caller's and their wards' requests in all clubs. */
  mine(context: ActorContext, personIds: readonly string[]): Promise<JoinRequest[]> {
    return this.db.withActor(context, (tx) => repo.myJoinRequests(tx, personIds));
  }

  /** Club names for "my requests" (applicant_read policy on clubs). */
  clubNames(context: ActorContext, clubIds: readonly string[]): Promise<Map<string, string>> {
    return this.db.withActor(context, async (tx) => {
      const clubs = await this.clubs.findClubsInTx(tx, [...new Set(clubIds)]);
      return new Map(clubs.map((c) => [c.id, c.name]));
    });
  }

  list(
    context: TenantContext,
    status: JoinRequestStatus,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: JoinRequest[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const result = await repo.clubJoinRequestsPage(tx, context.clubId, status, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      if (!result.cursorFound) throw new DomainError("invalid_cursor");
      const items = result.items.slice(0, page.limit);
      return { items, nextCursor: result.items.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** Approving creates the active membership in the same transaction. */
  decide(
    context: TenantContext,
    joinRequestId: string,
    decision: {
      decision: "approve" | "reject";
      message?: string | undefined;
      membershipType?: MembershipType | undefined;
    },
  ): Promise<JoinRequest> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await this.clubs.lockClubInTx(tx, context.clubId);
      const row = await repo.lockJoinRequest(tx, joinRequestId);
      if (!row) throw new DomainError("not_found");
      if (row.status !== "pending") throw new DomainError("invalid_input");
      const approve = decision.decision === "approve";
      if (approve) {
        await this.memberships.addMemberInTx(tx, context, row.personId, decision.membershipType);
      }
      const status = approve ? "approved" : "rejected";
      await repo.decideJoinRequest(tx, row.id, {
        status,
        decidedByPersonId: me,
        decisionMessage: decision.message ?? null,
      });
      await audit.record(tx, {
        action: approve ? "join_request.approved" : "join_request.rejected",
        resourceType: "join_request",
        resourceId: row.id,
        changedFields: ["status", "decided_at", "decision_message"],
      });
      await outbox.publish(tx, "join_request.decided", {
        joinRequestId: row.id,
        clubId: context.clubId,
      });
      return { ...row, status, decidedByPersonId: me, decisionMessage: decision.message ?? null };
    });
  }

  /** An accepted invitation settles the person's pending request in that club. */
  async settleByInvitationInTx(tx: Tx, clubId: string, personId: string): Promise<void> {
    const row = await repo.findPendingJoinRequest(tx, clubId, personId);
    if (!row) return;
    await repo.decideJoinRequest(tx, row.id, { status: "approved", decidedByPersonId: null });
    await audit.record(tx, {
      action: "join_request.approved",
      resourceType: "join_request",
      resourceId: row.id,
      changedFields: ["status", "decided_at"],
    });
  }

  private async checkPreferredGroups(tx: Tx, groupIds: readonly string[]): Promise<void> {
    if (groupIds.length === 0) return;
    const groups = await this.groups.findGroupsInTx(tx, [...new Set(groupIds)]);
    if (groups.length !== new Set(groupIds).size || groups.some((g) => g.archivedAt)) {
      throw new DomainError("invalid_input");
    }
  }
}
