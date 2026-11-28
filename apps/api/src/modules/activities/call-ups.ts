// SPDX-License-Identifier: AGPL-3.0-only
// Setting call-ups (ADR 0036, ADR 0056 as amended 2026-11-28): who is added
// and removed, the invitees_only flag, revocations, the audit events and the
// domain events for the notifications. Shared by the call-up page
// (attendance), a new activity created with its call-up (P2.7e), events
// (ADR 0038) and a series' call-up (P2.10), in bulk: a constant number of
// statements whatever the number of sessions.
//
// When a call-up goes out (decision 5 as amended): with its answer request
// (`request_at`, or once `requested_at` is set); without one
// CALLUP_DEFAULT_LEAD_HOURS before the start, or when saved inside that
// window. Until then, and within CALLUP_GRACE_MINUTES after it, changes are
// silent. After it, those added are told (`callup.added`) and removing
// someone is a revocation with a reason (`callup.revoked`).

import { audit, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import { CALLUP_DEFAULT_LEAD_HOURS, CALLUP_GRACE_MINUTES } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import * as repo from "./activities.repository.ts";
import * as records from "./attendance.repository.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Timing = Pick<repo.ActivityRow, "requestAt" | "requestedAt" | "startsAt" | "createdAt">;

/** When the activity's call-up went out, or null while it has not. */
export function callUpSentAt(activity: Timing, now: Date): Date | null {
  if (activity.requestedAt) return activity.requestedAt;
  if (activity.requestAt) return activity.requestAt <= now ? activity.requestAt : null;
  const lead = new Date(activity.startsAt.getTime() - CALLUP_DEFAULT_LEAD_HOURS * HOUR_MS);
  if (now < lead) return null;
  return activity.createdAt > lead ? activity.createdAt : lead;
}

/** Whether a change now tells people: the call-up went out, and its grace is over. */
export function callUpAnnounced(activity: Timing, now: Date): boolean {
  const sent = callUpSentAt(activity, now);
  return sent !== null && now.getTime() >= sent.getTime() + CALLUP_GRACE_MINUTES * MINUTE_MS;
}

export interface CallUpChange {
  activity: repo.ActivityRow;
  inviteesOnly: boolean;
  wanted: ReadonlySet<string>;
}

export interface CallUpResult {
  /** Per activity: those newly taking part, and those whose call-up was taken back. */
  added: Map<string, string[]>;
  revoked: Map<string, string[]>;
}

/**
 * Applies call-ups to activities. Revocations need `reason` (else
 * `revocation_reason_required`, nothing written). `seriesId`: the revocations
 * of a series' change are one notice per person listing the sessions.
 */
export async function applyCallUpsInTx(
  tx: Tx,
  context: TenantContext,
  changes: readonly CallUpChange[],
  options: {
    invitedBy: string;
    now: Date;
    reason?: string | null | undefined;
    seriesId?: string | null;
    revokedBy?: string | null;
  },
): Promise<CallUpResult> {
  const result: CallUpResult = { added: new Map(), revoked: new Map() };
  if (changes.length === 0) return result;
  const ids = changes.map((c) => c.activity.id);
  const current = await records.inviteesOf(tx, ids);
  // Who takes part without a call-up: needed where the mode is or was "whole groups".
  const needGroups = changes
    .filter((c) => !c.activity.inviteesOnly || !c.inviteesOnly)
    .map((c) => c.activity.id);
  const participants = await records.groupParticipantsOf(tx, needGroups);
  const toAdd: { activityId: string; personId: string }[] = [];
  const toRemove: { activityId: string; personId: string }[] = [];
  const revocations: { activityId: string; personId: string }[] = [];
  const unrevoke: { activityId: string; personId: string }[] = [];
  const modeOn: string[] = [];
  const modeOff: string[] = [];
  const changed: { activityId: string; added: string[]; removed: string[]; announced: boolean }[] =
    [];
  for (const change of changes) {
    const a = change.activity;
    const now = current.get(a.id) ?? new Set<string>();
    const groups = participants.get(a.id) ?? new Set<string>();
    const before = a.inviteesOnly ? now : groups;
    const after = change.inviteesOnly ? change.wanted : groups;
    const table = change.inviteesOnly ? change.wanted : new Set<string>();
    const tableAdded = [...table].filter((id) => !now.has(id));
    const tableRemoved = [...now].filter((id) => !table.has(id));
    const modeChanged = a.inviteesOnly !== change.inviteesOnly;
    if (!modeChanged && tableAdded.length === 0 && tableRemoved.length === 0) continue;
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    const announced = callUpAnnounced(a, options.now);
    for (const personId of tableAdded) toAdd.push({ activityId: a.id, personId });
    for (const personId of tableRemoved) toRemove.push({ activityId: a.id, personId });
    for (const personId of after) unrevoke.push({ activityId: a.id, personId });
    if (modeChanged) (change.inviteesOnly ? modeOn : modeOff).push(a.id);
    if (announced && removed.length > 0) {
      for (const personId of removed) revocations.push({ activityId: a.id, personId });
      result.revoked.set(a.id, removed);
    }
    if (added.length > 0) result.added.set(a.id, added);
    changed.push({ activityId: a.id, added, removed, announced });
  }
  if (revocations.length > 0 && !options.reason) {
    throw new DomainError("revocation_reason_required");
  }
  if (changed.length === 0) return result;
  await records.removeInviteePairs(tx, toRemove);
  await records.addInviteePairs(tx, context.clubId, toAdd, options.invitedBy);
  // Not a calendar change: neither sequence nor changed_at move (ADR 0036).
  await records.setInviteesOnly(tx, modeOn, true);
  await records.setInviteesOnly(tx, modeOff, false);
  if (modeOn.length + modeOff.length > 0) {
    await repo.syncScheduleEntries(tx, { activityIds: [...modeOn, ...modeOff] });
  }
  await records.removeRevocations(
    tx,
    unrevoke.filter(
      (u) => !revocations.some((r) => r.activityId === u.activityId && r.personId === u.personId),
    ),
  );
  await records.addRevocations(
    tx,
    context.clubId,
    revocations,
    options.reason ?? "",
    options.revokedBy ?? options.invitedBy,
  );
  await audit.recordMany(tx, [
    ...changed.map((c) => ({
      action: "activity.invitees.changed" as const,
      resourceType: "activity",
      resourceId: c.activityId,
      changedFields: ["invitees"],
    })),
    ...[...result.revoked.keys()].map((activityId) => ({
      action: "activity.callup.revoked" as const,
      resourceType: "activity",
      resourceId: activityId,
    })),
  ]);
  // Those to tell (ADR 0056 decision 6): added after it went out; removals
  // are revocations, never "removed" notices any more.
  await outbox.publishMany(
    tx,
    "activity.invitees.changed",
    changed.map((c) => ({
      clubId: context.clubId,
      activityId: c.activityId,
      added: c.announced ? c.added : [],
      removed: [],
    })),
  );
  if (result.revoked.size > 0) {
    if (options.seriesId) {
      await outbox.publish(tx, "activity.callup.revoked", {
        clubId: context.clubId,
        activityIds: [...result.revoked.keys()],
        personIds: [...new Set([...result.revoked.values()].flat())],
        seriesId: options.seriesId,
      });
    } else {
      await outbox.publishMany(
        tx,
        "activity.callup.revoked",
        [...result.revoked].map(([activityId, personIds]) => ({
          clubId: context.clubId,
          activityIds: [activityId],
          personIds,
          seriesId: null,
        })),
      );
    }
  }
  return result;
}

/** One activity's call-up (the call-up page, a new activity's, an event's). */
export async function applyCallUpInTx(
  tx: Tx,
  context: TenantContext,
  activity: repo.ActivityRow,
  inviteesOnly: boolean,
  wanted: ReadonlySet<string>,
  invitedBy: string,
  options: { now?: Date; reason?: string | null } = {},
): Promise<repo.ActivityRow> {
  await applyCallUpsInTx(tx, context, [{ activity, inviteesOnly, wanted }], {
    invitedBy,
    now: options.now ?? new Date(),
    reason: options.reason ?? null,
  });
  return (await repo.findActivity(tx, activity.id)) ?? activity;
}

/** The people who take part in the activity's groups (who may be called up). */
export async function callUpCandidatesInTx(tx: Tx, activityId: string): Promise<string[]> {
  return (await records.roster(tx, activityId, { wholeGroups: true }))
    .filter((r) => r.role === "participant")
    .map((r) => r.personId);
}
