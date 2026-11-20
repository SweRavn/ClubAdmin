// SPDX-License-Identifier: AGPL-3.0-only
// Setting an activity's call-up (ADR 0036): who is added and removed, the
// invitees_only flag, the audit event and the domain event for the
// notifications. Shared by the call-up page (attendance) and a new activity
// created with its call-up (P2.7e).

import { audit, outbox, type TenantContext, type Tx } from "@clubadmin/db";

import * as repo from "./activities.repository.ts";
import * as records from "./attendance.repository.ts";

export async function applyCallUpInTx(
  tx: Tx,
  context: TenantContext,
  activity: repo.ActivityRow,
  inviteesOnly: boolean,
  wanted: ReadonlySet<string>,
  invitedBy: string,
): Promise<repo.ActivityRow> {
  const activityId = activity.id;
  const current = new Set(await records.invitees(tx, activityId));
  const added = [...wanted].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !wanted.has(id));
  const modeChanged = activity.inviteesOnly !== inviteesOnly;
  if (!modeChanged && added.length === 0 && removed.length === 0) return activity;
  await records.removeInvitees(tx, activityId, removed);
  await records.addInvitees(tx, {
    clubId: context.clubId,
    activityId,
    personIds: added,
    invitedBy,
  });
  let updated = activity;
  if (modeChanged) {
    // Not a calendar change: neither sequence nor changed_at move (ADR 0036).
    updated = await repo.updateActivity(tx, activityId, { inviteesOnly });
    await repo.syncScheduleEntries(tx, { activityIds: [activityId] });
  }
  await audit.record(tx, {
    action: "activity.invitees.changed",
    resourceType: "activity",
    resourceId: activityId,
    changedFields: [
      ...(modeChanged ? ["invitees_only"] : []),
      ...(added.length > 0 || removed.length > 0 ? ["invitees"] : []),
    ],
  });
  await outbox.publish(tx, "activity.invitees.changed", {
    clubId: context.clubId,
    activityId,
    added,
    removed,
  });
  return updated;
}

/** The people who take part in the activity's groups (who may be called up). */
export async function callUpCandidatesInTx(tx: Tx, activityId: string): Promise<string[]> {
  return (await records.roster(tx, activityId, { wholeGroups: true }))
    .filter((r) => r.role === "participant")
    .map((r) => r.personId);
}
