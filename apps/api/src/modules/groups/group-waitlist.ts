// SPDX-License-Identifier: AGPL-3.0-only
// The waiting-list entries of groups (P1.10b, ADR 0043), as the groups
// module's exported building blocks: every status change writes its audit
// event and, where the applicant is told, an outbox event in the caller's
// transaction. The joining module's WaitlistsService decides (who may, the
// order, capacity, admission into the club) and calls these.

import { audit, isUniqueViolation, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import type { AuditAction, WaitlistClosedReason, WaitlistPriorityReason } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import * as repo from "./waitlist.repository.ts";

export type WaitlistEntry = repo.WaitlistEntryRow;
export type {
  ClubGroupCountsRow,
  DecisionRow,
  OpenGroupRow,
  OwnEntryRow,
  OwnerListRow,
  PositionRow,
  WaitlistSummaryRow,
} from "./waitlist.repository.ts";

const record = (tx: Tx, action: AuditAction, entryId: string, changedFields: string[]) =>
  audit.record(tx, {
    action,
    resourceType: "group_waitlist_entry",
    resourceId: entryId,
    changedFields,
  });

export class GroupWaitlist {
  /** The club of a group the caller may apply for (outsiders: public waiting lists only). */
  groupClubOfInTx(tx: Tx, groupId: string): Promise<string | null> {
    return repo.groupClubOf(tx, groupId);
  }

  /** The end of the day `days` after today in the club's time zone. */
  offerExpiryInTx(tx: Tx, timeZone: string, days: number): Promise<Date> {
    return repo.offerExpiry(tx, timeZone, days);
  }

  lockEntryInTx(tx: Tx, entryId: string): Promise<WaitlistEntry | null> {
    return repo.lockEntry(tx, entryId);
  }

  openEntryOfInTx(tx: Tx, groupId: string, personId: string): Promise<WaitlistEntry | null> {
    return repo.openEntryOf(tx, groupId, personId);
  }

  lockOpenEntryOfInTx(tx: Tx, groupId: string, personId: string): Promise<WaitlistEntry | null> {
    return repo.lockOpenEntryOf(tx, groupId, personId);
  }

  waitingAheadInTx(tx: Tx, entry: WaitlistEntry): Promise<number> {
    return repo.waitingAhead(tx, entry);
  }

  waitingCountInTx(tx: Tx, groupId: string): Promise<number> {
    return repo.waitingCount(tx, groupId);
  }

  summaryInTx(tx: Tx, groupId: string): Promise<repo.WaitlistSummaryRow> {
    return repo.summary(tx, groupId);
  }

  ownerListInTx(
    tx: Tx,
    groupId: string,
    query: Parameters<typeof repo.ownerList>[2],
  ): ReturnType<typeof repo.ownerList> {
    return repo.ownerList(tx, groupId, query);
  }

  clubGroupCountsInTx(tx: Tx, clubId: string): Promise<repo.ClubGroupCountsRow[]> {
    return repo.clubGroupCounts(tx, clubId);
  }

  decisionsInTx(
    tx: Tx,
    clubId: string,
    query: Parameters<typeof repo.decisions>[2],
  ): ReturnType<typeof repo.decisions> {
    return repo.decisions(tx, clubId, query);
  }

  ownEntriesInTx(tx: Tx, personIds: readonly string[]): Promise<repo.OwnEntryRow[]> {
    return repo.ownEntries(tx, personIds);
  }

  positionsInTx(tx: Tx, entryIds: readonly string[]): Promise<Map<string, repo.PositionRow>> {
    return repo.positions(tx, entryIds);
  }

  publicOpenGroupsInTx(tx: Tx, clubId: string): Promise<repo.OpenGroupRow[]> {
    return repo.publicOpenGroups(tx, clubId);
  }

  insiderOpenGroupsInTx(tx: Tx, clubId: string): Promise<repo.OpenGroupRow[]> {
    return repo.insiderOpenGroups(tx, clubId);
  }

  acceptedEntriesOfInTx(tx: Tx, clubId: string, personId: string): Promise<WaitlistEntry[]> {
    return repo.acceptedEntriesOf(tx, clubId, personId);
  }

  openEntriesWithJoinRequestInTx(tx: Tx, joinRequestId: string): Promise<number> {
    return repo.openEntriesWithJoinRequest(tx, joinRequestId);
  }

  /** A new `waiting` entry; the requester is told (`waitlist.entry.created`). */
  async createInTx(
    tx: Tx,
    context: TenantContext,
    values: {
      groupId: string;
      personId: string;
      requestedByPersonId: string;
      applicantNote: string | null;
      joinRequestId: string | null;
    },
  ): Promise<WaitlistEntry> {
    let row: WaitlistEntry;
    try {
      row = await repo.insertEntry(tx, { ...values, clubId: context.clubId });
    } catch (error) {
      if (isUniqueViolation(error, "group_waitlist_entries_open_unique")) {
        throw new DomainError("already_on_waitlist");
      }
      throw error;
    }
    await record(tx, "group.waitlist.created", row.id, [
      "status",
      ...(values.applicantNote ? ["applicant_note"] : []),
      ...(values.joinRequestId ? ["join_request_id"] : []),
    ]);
    await outbox.publish(tx, "waitlist.entry.created", {
      clubId: context.clubId,
      entryId: row.id,
    });
    return row;
  }

  /** Priority (with its reason) and the owners' note. */
  async updateInTx(
    tx: Tx,
    entry: WaitlistEntry,
    patch: {
      priority?: number | undefined;
      priorityReason?: WaitlistPriorityReason | null | undefined;
      ownerNote?: string | null | undefined;
    },
  ): Promise<WaitlistEntry> {
    const priority = patch.priority ?? entry.priority;
    const priorityReason =
      priority === 0
        ? null
        : patch.priorityReason !== undefined
          ? patch.priorityReason
          : entry.priorityReason;
    if (priority > 0 && !priorityReason) throw new DomainError("priority_reason_required");
    const priorityChanged = priority !== entry.priority || priorityReason !== entry.priorityReason;
    const noteChanged =
      patch.ownerNote !== undefined && (patch.ownerNote || null) !== entry.ownerNote;
    if (!priorityChanged && !noteChanged) return entry;
    const row = await repo.updateEntry(tx, entry.id, {
      priority,
      priorityReason,
      ...(noteChanged ? { ownerNote: patch.ownerNote || null } : {}),
    });
    if (priorityChanged) {
      await record(tx, "group.waitlist.priority_changed", entry.id, [
        "priority",
        "priority_reason",
      ]);
    }
    if (noteChanged) await record(tx, "group.waitlist.updated", entry.id, ["owner_note"]);
    return row;
  }

  /** Offers a place until `expiresAt`; `offeredBy` null is the worker. The applicant is told. */
  async offerInTx(
    tx: Tx,
    context: TenantContext,
    entry: WaitlistEntry,
    offer: { expiresAt: Date; outOfOrderReason: string | null; overCapacity: boolean },
  ): Promise<WaitlistEntry> {
    const row = await repo.updateEntry(tx, entry.id, {
      status: "offered",
      offeredAt: new Date(),
      offeredByPersonId: context.personId ?? null,
      offerExpiresAt: offer.expiresAt,
      decidedByPersonId: context.personId ?? null,
      decidedAt: new Date(),
      ...(offer.outOfOrderReason ? { outOfOrderReason: offer.outOfOrderReason } : {}),
    });
    await record(tx, "group.waitlist.offered", entry.id, [
      "status",
      "offer_expires_at",
      ...(offer.outOfOrderReason ? ["out_of_order_reason"] : []),
      ...(offer.overCapacity ? ["over_capacity"] : []),
    ]);
    await outbox.publish(tx, "waitlist.offer.sent", { clubId: context.clubId, entryId: entry.id });
    return row;
  }

  /** Back in line with the original queued_at. */
  async withdrawOfferInTx(tx: Tx, entry: WaitlistEntry): Promise<WaitlistEntry> {
    const row = await repo.updateEntry(tx, entry.id, {
      status: "waiting",
      offeredAt: null,
      offeredByPersonId: null,
      offerExpiresAt: null,
      outOfOrderReason: null,
    });
    await record(tx, "group.waitlist.offer_withdrawn", entry.id, ["status", "offer_expires_at"]);
    return row;
  }

  /** Accepted, waiting for the club to approve the join request (holds the place). */
  async acceptInTx(tx: Tx, entry: WaitlistEntry): Promise<WaitlistEntry> {
    const row = await repo.updateEntry(tx, entry.id, {
      status: "accepted",
      offerExpiresAt: null,
    });
    await record(tx, "group.waitlist.accepted", entry.id, ["status"]);
    return row;
  }

  /** Records an owner's out-of-turn decision on an entry that waits for the club. */
  async updateDecisionInTx(
    tx: Tx,
    context: TenantContext,
    entry: WaitlistEntry,
    outOfOrderReason: string,
  ): Promise<WaitlistEntry> {
    const row = await repo.updateEntry(tx, entry.id, {
      outOfOrderReason,
      decidedByPersonId: context.personId ?? null,
      decidedAt: new Date(),
    });
    await record(tx, "group.waitlist.updated", entry.id, ["out_of_order_reason"]);
    return row;
  }

  /** Admitted: the group membership exists. The applicant is told. */
  async admitInTx(
    tx: Tx,
    context: TenantContext,
    entry: WaitlistEntry,
    options: { outOfOrderReason: string | null; overCapacity: boolean },
  ): Promise<WaitlistEntry> {
    const direct = entry.status === "waiting";
    const row = await repo.updateEntry(tx, entry.id, {
      status: "admitted",
      offerExpiresAt: null,
      ...(direct ? { decidedByPersonId: context.personId ?? null, decidedAt: new Date() } : {}),
      ...(options.outOfOrderReason ? { outOfOrderReason: options.outOfOrderReason } : {}),
    });
    await record(tx, "group.waitlist.admitted", entry.id, [
      "status",
      ...(options.outOfOrderReason ? ["out_of_order_reason"] : []),
      ...(options.overCapacity ? ["over_capacity"] : []),
    ]);
    await outbox.publish(tx, "waitlist.admitted", { clubId: context.clubId, entryId: entry.id });
    return row;
  }

  /**
   * Closes an open entry: `declined` (the applicant), `withdrawn` (the
   * applicant) or `removed` (an owner or the club, with the reason; the
   * applicant is told).
   */
  async closeInTx(
    tx: Tx,
    context: TenantContext,
    entry: WaitlistEntry,
    status: "declined" | "withdrawn" | "removed",
    reason: WaitlistClosedReason,
  ): Promise<WaitlistEntry> {
    const row = await repo.updateEntry(tx, entry.id, {
      status,
      closedReason: reason,
      offerExpiresAt: null,
      decidedByPersonId: context.personId ?? null,
      decidedAt: new Date(),
    });
    const action: AuditAction =
      status === "declined"
        ? "group.waitlist.declined"
        : status === "withdrawn"
          ? "group.waitlist.withdrawn"
          : "group.waitlist.removed";
    await record(tx, action, entry.id, ["status", "closed_reason"]);
    if (status === "removed") {
      await outbox.publish(tx, "waitlist.entry.closed", {
        clubId: context.clubId,
        entryId: entry.id,
      });
    }
    return row;
  }

  /**
   * Closes the person's open entries in the club because the club rejected
   * their join request (`join_request_rejected`); they are told.
   */
  async closeForRejectedJoinRequestInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
  ): Promise<number> {
    const ids = await repo.closeOpenEntriesOf(
      tx,
      context.clubId,
      personId,
      "removed",
      "join_request_rejected",
      context.personId ?? null,
    );
    for (const id of ids) {
      await record(tx, "group.waitlist.closed", id, ["status", "closed_reason"]);
      await outbox.publish(tx, "waitlist.entry.closed", { clubId: context.clubId, entryId: id });
    }
    return ids.length;
  }
}
