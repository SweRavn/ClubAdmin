// SPDX-License-Identifier: AGPL-3.0-only
// Waiting lists of groups (P1.10b, ADR 0043): applying (also from outside
// the club, with a pending join request in the same transaction), the
// applicant's answers to an offer, the owners' decisions in fair order
// (priority, then time; anyone skipped needs a reason) and the club
// managers' view. Entries change through the groups module's GroupWaitlist,
// admission through waitlist-admission.ts.

import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type AdmitWaitlistEntryInput,
  type ApplyWaitlistInput,
  type GroupWaitlistQuery,
  type OfferWaitlistEntryInput,
  type UpdateWaitlistEntryInput,
  type WaitlistClosedReason,
  type WaitlistRemovalReason,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type {
  ClubGroupCountsRow,
  DecisionRow,
  Group,
  GroupsService,
  OpenGroupRow,
  OwnerListRow,
  WaitlistEntry,
} from "../groups/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import * as repo from "./joining.repository.ts";
import { type AdmissionDeps, admitInTx } from "./waitlist-admission.ts";

const OPEN = new Set(["waiting", "offered", "accepted"]);

const removalReason = (reason: WaitlistRemovalReason): WaitlistClosedReason =>
  reason === "other" ? "removed_by_owner" : reason;

/**
 * Who the applicant's side acts for: the caller and their wards (to find the
 * entry) and whether the caller may act for a person (themselves, or a ward
 * with act_on_behalf; only that ward with X-On-Behalf-Of).
 */
export interface Applicant {
  personIds: readonly string[];
  actsFor: (personId: string) => boolean;
}

export class WaitlistsService {
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

  private get deps(): AdmissionDeps {
    return { clubs: this.clubs, groups: this.groups, memberships: this.memberships };
  }

  // --- The applicant's side ------------------------------------------------------------

  /**
   * Groups open for applications in the club: insiders (members, or
   * guardians of members) see every group with a waiting list; others the
   * publicly visible ones of a club the search lists (app.club_open_groups).
   */
  openGroups(context: ActorContext, clubId: string, insider: boolean): Promise<OpenGroupRow[]> {
    if (insider) {
      return this.db.withTenant({ ...context, clubId }, (tx) =>
        this.groups.waitlist.insiderOpenGroupsInTx(tx, clubId),
      );
    }
    return this.db.withActor(context, (tx) =>
      this.groups.waitlist.publicOpenGroupsInTx(tx, clubId),
    );
  }

  /** The club of a group the caller may apply for, else not_found. */
  async clubOfGroup(context: ActorContext, groupId: string): Promise<string> {
    const clubId = await this.db.withActor(context, (tx) =>
      this.groups.waitlist.groupClubOfInTx(tx, groupId),
    );
    if (!clubId) throw new DomainError("not_found");
    return clubId;
  }

  /**
   * Puts the person on the group's waiting list (the caller checked that the
   * person is them or a ward they act for). Allowed with admission_mode =
   * waitlist; with direct for members of the club (P1.14: an owner admits
   * them), and for others when the group is full. Someone outside the club gets
   * a pending join request with this group as preference (or their pending
   * one is reused), in the same transaction; invite_only clubs answer 404.
   */
  apply(
    context: TenantContext,
    groupId: string,
    input: ApplyWaitlistInput,
  ): Promise<{ entry: WaitlistEntry; joinRequestId: string | null }> {
    const requester = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const club = await this.requireActiveClub(tx, context.clubId);
      const group = await this.groups.lockGroupInTx(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      const membership = await this.memberships.openMembershipInTx(
        tx,
        context.clubId,
        input.personId,
      );
      const member = membership?.status === "active" || membership?.status === "paused";
      if (!member) {
        const requesterMember = await this.memberships.isMemberInTx(tx, context.clubId, requester);
        // Outsiders reach listed clubs and public waiting lists only.
        if (
          !requesterMember &&
          (club.joinPolicy === "invite_only" || !group.waitlistVisiblePublicly)
        ) {
          throw new DomainError("not_found");
        }
      }
      await this.checkAdmissionMode(tx, group, member);
      if (await this.memberships.hasGroupFunctionInTx(tx, groupId, input.personId, "member")) {
        throw new DomainError("already_in_group");
      }
      if (await this.groups.waitlist.openEntryOfInTx(tx, groupId, input.personId)) {
        throw new DomainError("already_on_waitlist");
      }
      let joinRequestId: string | null = null;
      if (!member) {
        await this.accounts.requireReadyForClubsInTx(tx, requester);
        joinRequestId = await this.joinRequestFor(tx, context, input.personId, requester, groupId);
      }
      const entry = await this.groups.waitlist.createInTx(tx, context, {
        groupId,
        personId: input.personId,
        requestedByPersonId: requester,
        applicantNote: input.note ?? null,
        joinRequestId,
      });
      return { entry, joinRequestId };
    });
  }

  /** The entry for the applicant's answers, from any club; not_found unless the caller acts for it. */
  private async ownEntry(
    context: ActorContext,
    entryId: string,
    applicant: Applicant,
  ): Promise<{ clubId: string; personId: string }> {
    const found = await this.db.withActor(context, async (tx) =>
      (await this.groups.waitlist.ownEntriesInTx(tx, applicant.personIds)).find(
        (e) => e.id === entryId,
      ),
    );
    if (!found || !applicant.actsFor(found.personId)) throw new DomainError("not_found");
    return found;
  }

  /** Leaves the waiting list. Withdrawing the last open entry also withdraws its join request. */
  async withdraw(context: ActorContext, entryId: string, applicant: Applicant): Promise<void> {
    const { clubId } = await this.ownEntry(context, entryId, applicant);
    await this.db.withTenant({ ...context, clubId }, async (tx) => {
      await this.requireActiveClub(tx, clubId);
      const entry = await this.lockOpen(tx, entryId);
      const tenant = { ...context, clubId };
      await this.groups.waitlist.closeInTx(tx, tenant, entry, "withdrawn", "withdrawn");
      await this.settleJoinRequest(tx, tenant, entry);
    });
  }

  /** Declines an offer: the entry closes (decision 1); the next auto-offer follows. */
  async decline(context: ActorContext, entryId: string, applicant: Applicant): Promise<void> {
    const { clubId } = await this.ownEntry(context, entryId, applicant);
    await this.db.withTenant({ ...context, clubId }, async (tx) => {
      await this.requireActiveClub(tx, clubId);
      const entry = await this.lockOpen(tx, entryId);
      if (entry.status !== "offered") throw new DomainError("waitlist_entry_closed");
      const tenant = { ...context, clubId };
      await this.groups.waitlist.closeInTx(tx, tenant, entry, "declined", "declined");
      await this.settleJoinRequest(tx, tenant, entry);
    });
  }

  /** Accepts an offer before it expires (server clock): admitted, or accepted while the club decides. */
  async accept(
    context: ActorContext,
    entryId: string,
    applicant: Applicant,
  ): Promise<WaitlistEntry> {
    const { clubId } = await this.ownEntry(context, entryId, applicant);
    const tenant = { ...context, clubId };
    return this.db.withTenant(tenant, async (tx) => {
      await this.requireActiveClub(tx, clubId);
      const entry = await this.groups.waitlist.lockEntryInTx(tx, entryId);
      if (!entry) throw new DomainError("not_found");
      if (entry.status === "expired") throw new DomainError("offer_expired");
      if (entry.status !== "offered") throw new DomainError("waitlist_entry_closed");
      if (!entry.offerExpiresAt || entry.offerExpiresAt <= new Date()) {
        throw new DomainError("offer_expired");
      }
      await this.groups.lockGroupInTx(tx, entry.groupId);
      return admitInTx(tx, tenant, this.deps, entry, {
        outOfOrderReason: null,
        overCapacity: false,
      });
    });
  }

  // --- The owners' side ------------------------------------------------------------------

  list(
    context: TenantContext,
    groupId: string,
    query: GroupWaitlistQuery,
  ): Promise<{ items: OwnerListRow[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const { rows, cursorFound } = await this.groups.waitlist.ownerListInTx(tx, groupId, {
        status: query.status,
        birthYear: query.birthYear ?? null,
        fitsGender: query.fitsGender === "true",
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      if (!cursorFound) throw new DomainError("invalid_cursor");
      const items = rows.slice(0, query.limit);
      return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  summary(
    context: TenantContext,
    groupId: string,
  ): Promise<{
    group: Group;
    capacity: number | null;
    occupied: number;
    waiting: number;
    offers: number;
    accepted: number;
  }> {
    return this.db.withTenant(context, async (tx) => ({
      group: await this.groups.getGroupInTx(tx, groupId),
      ...(await this.groups.waitlist.summaryInTx(tx, groupId)),
    }));
  }

  update(
    context: TenantContext,
    groupId: string,
    entryId: string,
    input: UpdateWaitlistEntryInput,
  ): Promise<WaitlistEntry> {
    return this.db.withTenant(context, async (tx) => {
      const entry = await this.lockInGroup(tx, groupId, entryId);
      if (!OPEN.has(entry.status)) throw new DomainError("waitlist_entry_closed");
      return this.groups.waitlist.updateInTx(tx, entry, input);
    });
  }

  /**
   * Offers a place until the end of the day `replyDays` (default: the
   * group's) after today in the club's time zone. Anyone waiting ahead needs
   * a reason; a full group needs overCapacity.
   */
  offer(
    context: TenantContext,
    groupId: string,
    entryId: string,
    input: OfferWaitlistEntryInput,
  ): Promise<WaitlistEntry> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.requireActiveClub(tx, context.clubId);
      const group = await this.groups.lockGroupInTx(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      const entry = await this.lockInGroup(tx, groupId, entryId);
      if (entry.status !== "waiting") throw new DomainError("waitlist_entry_closed");
      const checks = await this.checkTurnAndPlace(tx, entry, input);
      const expiresAt = await this.groups.waitlist.offerExpiryInTx(
        tx,
        club.timeZone,
        input.replyDays ?? group.offerReplyDays,
      );
      return this.groups.waitlist.offerInTx(tx, context, entry, { expiresAt, ...checks });
    });
  }

  withdrawOffer(context: TenantContext, groupId: string, entryId: string): Promise<WaitlistEntry> {
    return this.db.withTenant(context, async (tx) => {
      const entry = await this.lockInGroup(tx, groupId, entryId);
      if (entry.status !== "offered") throw new DomainError("waitlist_entry_closed");
      return this.groups.waitlist.withdrawOfferInTx(tx, entry);
    });
  }

  /** Admits directly, without an offer; same reason and capacity rules for a waiting entry. */
  admit(
    context: TenantContext,
    groupId: string,
    entryId: string,
    input: AdmitWaitlistEntryInput,
  ): Promise<WaitlistEntry> {
    return this.db.withTenant(context, async (tx) => {
      await this.requireActiveClub(tx, context.clubId);
      const group = await this.groups.lockGroupInTx(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      const entry = await this.lockInGroup(tx, groupId, entryId);
      if (!OPEN.has(entry.status)) throw new DomainError("waitlist_entry_closed");
      const checks =
        entry.status === "waiting"
          ? await this.checkTurnAndPlace(tx, entry, input)
          : { outOfOrderReason: null, overCapacity: false };
      return admitInTx(tx, context, this.deps, entry, checks);
    });
  }

  remove(
    context: TenantContext,
    groupId: string,
    entryId: string,
    reason: WaitlistRemovalReason,
  ): Promise<WaitlistEntry> {
    return this.db.withTenant(context, async (tx) => {
      const entry = await this.lockInGroup(tx, groupId, entryId);
      if (!OPEN.has(entry.status)) throw new DomainError("waitlist_entry_closed");
      const row = await this.groups.waitlist.closeInTx(
        tx,
        context,
        entry,
        "removed",
        removalReason(reason),
      );
      await this.settleJoinRequest(tx, context, entry);
      return row;
    });
  }

  // --- Club managers -----------------------------------------------------------------

  clubView(
    context: TenantContext,
    query: { from: Date; cursor: string | null; limit: number },
  ): Promise<{
    groups: ClubGroupCountsRow[];
    decisions: DecisionRow[];
    nextCursor: string | null;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const groups = query.cursor
        ? []
        : await this.groups.waitlist.clubGroupCountsInTx(tx, context.clubId);
      const { rows, cursorFound } = await this.groups.waitlist.decisionsInTx(tx, context.clubId, {
        ...query,
        limit: query.limit + 1,
      });
      if (!cursorFound) throw new DomainError("invalid_cursor");
      const decisions = rows.slice(0, query.limit);
      return {
        groups,
        decisions,
        nextCursor: rows.length > query.limit ? decisions.at(-1)!.id : null,
      };
    });
  }

  // --- Helpers ----------------------------------------------------------------------

  /**
   * An active club that takes changes: the applicant's endpoints have no club
   * resource for the access-state guard, so they check here (ADR 0031).
   */
  private async requireActiveClub(tx: Tx, clubId: string) {
    const club = await this.clubs.getClubInTx(tx, clubId);
    if (club.status !== "active") throw new DomainError("not_found");
    if (club.accessState === "suspended") throw new ProblemError("club-suspended");
    if (club.accessState === "read_only") throw new ProblemError("club-read-only");
    return club;
  }

  private async checkAdmissionMode(tx: Tx, group: Group, member: boolean): Promise<void> {
    if (group.admissionMode === "waitlist") return;
    if (group.admissionMode === "direct") {
      // Members ask for a place also when there are free places (P1.14).
      if (member) return;
      const { capacity, occupied } = await this.groups.capacityInTx(tx, group.id);
      if (capacity !== null && occupied >= capacity) return;
    }
    throw new DomainError("admission_closed");
  }

  /** Anyone waiting ahead needs a reason; a full group needs overCapacity. */
  private async checkTurnAndPlace(
    tx: Tx,
    entry: WaitlistEntry,
    input: { outOfOrderReason?: string | undefined; overCapacity?: boolean | undefined },
  ): Promise<{ outOfOrderReason: string | null; overCapacity: boolean }> {
    const ahead = await this.groups.waitlist.waitingAheadInTx(tx, entry);
    const reason = input.outOfOrderReason?.trim() || null;
    if (ahead > 0 && !reason) throw new DomainError("out_of_order_reason_required");
    const { capacity, occupied } = await this.groups.capacityInTx(tx, entry.groupId);
    const full = capacity !== null && occupied >= capacity;
    if (full && !input.overCapacity) throw new DomainError("group_full");
    return { outOfOrderReason: ahead > 0 ? reason : null, overCapacity: full };
  }

  private async lockInGroup(tx: Tx, groupId: string, entryId: string): Promise<WaitlistEntry> {
    const entry = await this.groups.waitlist.lockEntryInTx(tx, entryId);
    if (!entry || entry.groupId !== groupId) throw new DomainError("not_found");
    return entry;
  }

  private async lockOpen(tx: Tx, entryId: string): Promise<WaitlistEntry> {
    const entry = await this.groups.waitlist.lockEntryInTx(tx, entryId);
    if (!entry) throw new DomainError("not_found");
    if (!OPEN.has(entry.status)) throw new DomainError("waitlist_entry_closed");
    return entry;
  }

  /** The pending join request created with an application, or a new one, with the group preferred. */
  private async joinRequestFor(
    tx: Tx,
    context: TenantContext,
    personId: string,
    requester: string,
    groupId: string,
  ): Promise<string> {
    const pending = await repo.findPendingJoinRequest(tx, context.clubId, personId);
    if (pending) {
      if (!pending.preferredGroupIds.includes(groupId)) {
        await repo.updatePreferredGroups(tx, pending.id, [...pending.preferredGroupIds, groupId]);
        await audit.record(tx, {
          action: "join_request.updated",
          resourceType: "join_request",
          resourceId: pending.id,
          changedFields: ["preferred_group_ids"],
        });
      }
      return pending.id;
    }
    try {
      const row = await repo.insertJoinRequest(tx, {
        clubId: context.clubId,
        personId,
        requestedByPersonId: requester,
        message: null,
        preferredGroupIds: [groupId],
      });
      await audit.record(tx, {
        action: "join_request.created",
        resourceType: "join_request",
        resourceId: row.id,
        changedFields: ["status", "preferred_group_ids"],
      });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error, "join_requests_pending_unique")) {
        throw new DomainError("join_request_exists");
      }
      throw error;
    }
  }

  /**
   * The entry closed: if it was the last open entry created with a pending
   * join request, the request is withdrawn too (nobody becomes a member
   * without a group, decision 2).
   */
  private async settleJoinRequest(
    tx: Tx,
    context: TenantContext,
    entry: WaitlistEntry,
  ): Promise<void> {
    if (!entry.joinRequestId) return;
    if ((await this.groups.waitlist.openEntriesWithJoinRequestInTx(tx, entry.joinRequestId)) > 0) {
      return;
    }
    const request = await repo.lockJoinRequest(tx, entry.joinRequestId);
    if (!request || request.status !== "pending") return;
    await repo.decideJoinRequest(tx, request.id, {
      status: "withdrawn",
      decidedByPersonId: context.personId ?? null,
    });
    await audit.record(tx, {
      action: "join_request.withdrawn",
      resourceType: "join_request",
      resourceId: request.id,
      changedFields: ["status", "decided_at"],
    });
  }
}
