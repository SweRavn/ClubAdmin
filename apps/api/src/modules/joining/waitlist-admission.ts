// SPDX-License-Identifier: AGPL-3.0-only
// Admission from a waiting list (P1.10b, ADR 0043), shared by the waiting
// lists and the join requests: in the caller's transaction, with the entry
// locked. A member of the club (active or paused) gets the group membership
// and the entry becomes `admitted`. Someone outside the club is admitted to
// the club too when group_owners_admit_to_club is on (their pending join
// request approved, else a membership created); otherwise the entry becomes
// `accepted` and holds its place until the club decides the join request.

import { audit, outbox, type TenantContext, type Tx } from "@clubadmin/db";

import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService, WaitlistEntry } from "../groups/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import * as repo from "./joining.repository.ts";

export interface AdmissionDeps {
  clubs: ClubsService;
  groups: GroupsService;
  memberships: MembershipsService;
}

export interface AdmissionOptions {
  outOfOrderReason: string | null;
  overCapacity: boolean;
}

/** Approves the person's pending join request (if any) and makes them a member. */
async function admitToClubInTx(
  tx: Tx,
  context: TenantContext,
  deps: AdmissionDeps,
  personId: string,
): Promise<void> {
  const pending = await repo.findPendingJoinRequest(tx, context.clubId, personId);
  await deps.memberships.addMemberInTx(tx, context, personId);
  if (!pending) return;
  await repo.decideJoinRequest(tx, pending.id, {
    status: "approved",
    decidedByPersonId: context.personId ?? null,
  });
  await audit.record(tx, {
    action: "join_request.approved",
    resourceType: "join_request",
    resourceId: pending.id,
    changedFields: ["status", "decided_at"],
  });
  await outbox.publish(tx, "join_request.decided", {
    joinRequestId: pending.id,
    clubId: context.clubId,
  });
}

/** Adds the group membership and marks the entry admitted. */
export async function admitMemberInTx(
  tx: Tx,
  context: TenantContext,
  deps: AdmissionDeps,
  entry: WaitlistEntry,
  options: AdmissionOptions,
): Promise<WaitlistEntry> {
  await deps.memberships.addToGroupInTx(tx, context, entry.groupId, entry.personId, "member");
  return deps.groups.waitlist.admitInTx(tx, context, entry, options);
}

/** Admits the entry, or moves it to `accepted` while the club decides. */
export async function admitInTx(
  tx: Tx,
  context: TenantContext,
  deps: AdmissionDeps,
  entry: WaitlistEntry,
  options: AdmissionOptions,
): Promise<WaitlistEntry> {
  const membership = await deps.memberships.openMembershipInTx(tx, context.clubId, entry.personId);
  const member = membership?.status === "active" || membership?.status === "paused";
  if (!member) {
    const club = await deps.clubs.getClubInTx(tx, context.clubId);
    if (!club.groupOwnersAdmitToClub) {
      if (entry.status === "accepted") return entry;
      const accepted = await deps.groups.waitlist.acceptInTx(tx, entry);
      // The out-of-order reason (an owner admitting out of turn) is kept with it.
      return options.outOfOrderReason
        ? deps.groups.waitlist.updateDecisionInTx(tx, context, accepted, options.outOfOrderReason)
        : accepted;
    }
    await admitToClubInTx(tx, context, deps, entry.personId);
  }
  return admitMemberInTx(tx, context, deps, entry, options);
}

/**
 * The club approved the person's join request: their `accepted` entries in
 * the club are admitted in the same transaction.
 */
export async function admitAcceptedEntriesInTx(
  tx: Tx,
  context: TenantContext,
  deps: AdmissionDeps,
  personId: string,
): Promise<number> {
  const entries = await deps.groups.waitlist.acceptedEntriesOfInTx(tx, context.clubId, personId);
  for (const entry of entries) {
    await admitMemberInTx(tx, context, deps, entry, {
      outOfOrderReason: null,
      overCapacity: false,
    });
  }
  return entries.length;
}
