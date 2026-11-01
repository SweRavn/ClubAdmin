// SPDX-License-Identifier: AGPL-3.0-only
// Account deletion and ward erasure (P1.8b, ADR 0041). A person schedules
// the deletion of their account after a grace period, and chooses for each
// ward without a login whose only full guardian with a login they are
// whether the ward goes too; a full guardian schedules the erasure of a ward
// without a login, which every other full guardian is told about and may
// cancel. Neither is possible while the person (or a ward to be erased)
// holds a club role, a leader function or a group ownership, or owes a club
// invoices: the preview names each, with the club. The erasure itself is
// privacy:erase (erasure.job.ts), which checks again.

import { type ActorContext, audit, type Database, outbox, type Tx } from "@clubadmin/db";
import type { Assignment, ClubRole, ErasureBlocker, GroupFunction } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import * as repo from "./data-rights.repository.ts";
import type { OutstandingObligationsProvider } from "./outstanding-obligations.ts";

export interface ErasureOptions {
  /** ERASURE_GRACE_DAYS: days between the request and the erasure. */
  graceDays: number;
  obligations: readonly OutstandingObligationsProvider[];
  now?: () => Date;
}

export interface DeletionPreviewData {
  graceDays: number;
  blockers: ErasureBlocker[];
  /** Wards erased with the account unless kept, each with their own blockers. */
  wards: { personId: string; blockers: ErasureBlocker[] }[];
  pending: repo.ErasureRequestRow | null;
}

export interface WardPreviewData {
  graceDays: number;
  hasLogin: boolean;
  blockers: ErasureBlocker[];
  pending: repo.ErasureRequestRow | null;
}

const DAY_MS = 86_400_000;

const personOf = (context: ActorContext): string => {
  if (!context.personId) throw new DomainError("not_allowed");
  return context.personId;
};

/**
 * Blockers from the assignment facts (and the obligation providers for the
 * clubs the people are members of), per person and club.
 */
export async function erasureBlockersInTx(
  tx: Tx,
  personIds: readonly string[],
  obligations: readonly OutstandingObligationsProvider[],
  facts: (
    tx: Tx,
    personIds: readonly string[],
  ) => Promise<repo.AssignmentFact[]> = repo.assignmentFacts,
): Promise<ErasureBlocker[]> {
  const found = await facts(tx, personIds);
  const byKey = new Map<string, { personId: string; clubId: string; clubName: string }>();
  const assignments = new Map<string, Assignment[]>();
  const lastManager = new Set<string>();
  for (const f of found) {
    const key = `${f.personId}:${f.clubId}`;
    byKey.set(key, { personId: f.personId, clubId: f.clubId, clubName: f.clubName });
    if (f.kind === "membership") continue;
    const list = assignments.get(key) ?? [];
    if (f.kind === "role") {
      list.push({
        id: f.assignmentId,
        kind: "role",
        role: f.role as ClubRole,
        blockedBy: f.lastManager ? "last_club_manager" : null,
      });
      if (f.lastManager) lastManager.add(key);
    } else if (f.kind === "group_function") {
      list.push({
        id: f.assignmentId,
        kind: "group_function",
        groupId: f.groupId!,
        groupName: f.groupName ?? "",
        function: f.groupFunction as GroupFunction,
        blockedBy: null,
      });
    } else {
      list.push({
        id: f.assignmentId,
        kind: "group_owner",
        groupId: f.groupId!,
        groupName: f.groupName ?? "",
        blockedBy: null,
      });
    }
    assignments.set(key, list);
  }
  const blockers: ErasureBlocker[] = [];
  for (const [key, where] of byKey) {
    if (lastManager.has(key)) blockers.push({ ...where, code: "last_club_manager" });
    const held = assignments.get(key);
    if (held && held.length > 0) {
      blockers.push({ ...where, code: "roles_must_be_removed", assignments: held });
    }
    let count = 0;
    let contactRole: ClubRole = "treasurer";
    for (const provider of obligations) {
      const owed = await provider.forPerson(tx, where.clubId, where.personId);
      if (owed && owed.count > 0) {
        count += owed.count;
        contactRole = owed.contactRole;
      }
    }
    if (count > 0) blockers.push({ ...where, code: "outstanding_invoices", count, contactRole });
  }
  return blockers;
}

export class ErasureService {
  private readonly db: Database;
  private readonly options: ErasureOptions;

  constructor(db: Database, options: ErasureOptions) {
    this.db = db;
    this.options = options;
  }

  get graceDays(): number {
    return this.options.graceDays;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Wards erased with the guardian's account by default: no login, no other guardian with one. */
  private async soleLoginWardsInTx(tx: Tx, guardianId: string): Promise<string[]> {
    return (await repo.wardLogins(tx, guardianId))
      .filter((w) => !w.wardHasLogin && w.otherGuardiansWithLogin === 0)
      .map((w) => w.wardPersonId);
  }

  /** What deleting the caller's account needs and takes with it. */
  deletionPreview(context: ActorContext): Promise<DeletionPreviewData> {
    return this.db.withActor(context, async (tx) => {
      const me = personOf(context);
      const wards = await this.soleLoginWardsInTx(tx, me);
      const blockers = await erasureBlockersInTx(tx, [me, ...wards], this.options.obligations);
      const [pending] = await repo.openErasures(tx, [me]);
      return {
        graceDays: this.options.graceDays,
        blockers: blockers.filter((b) => b.personId === me),
        wards: wards.map((personId) => ({
          personId,
          blockers: blockers.filter((b) => b.personId === personId),
        })),
        pending: pending ?? null,
      };
    });
  }

  /** Schedules the caller's account deletion (and the chosen wards'). */
  scheduleDeletion(
    context: ActorContext,
    eraseWardIds: readonly string[],
  ): Promise<repo.ErasureRequestRow> {
    return this.db.withActor(context, async (tx) => {
      const me = personOf(context);
      const wards = [...new Set(eraseWardIds)];
      const allowed = new Set(await this.soleLoginWardsInTx(tx, me));
      if (wards.some((w) => !allowed.has(w))) throw new DomainError("not_found");
      if ((await repo.openErasures(tx, [me, ...wards])).length > 0) {
        throw new DomainError("erasure_pending");
      }
      const blockers = await erasureBlockersInTx(tx, [me, ...wards], this.options.obligations);
      if (blockers.length > 0) throw new DomainError("erasure_blocked");
      const request = await repo.insertErasure(tx, {
        personId: me,
        requestedByPersonId: me,
        kind: "account_deletion",
        scheduledFor: new Date(this.now().getTime() + this.options.graceDays * DAY_MS),
        includeWardIds: wards,
      });
      if (!request) throw new DomainError("erasure_pending");
      await audit.record(tx, {
        action: "account.deletion.scheduled",
        resourceType: "erasure_request",
        resourceId: request.id,
        changedFields: wards.length > 0 ? ["include_ward_ids"] : [],
      });
      await outbox.publish(tx, "privacy.erasure.scheduled", { requestId: request.id });
      return request;
    });
  }

  /** Cancels the caller's scheduled account deletion. */
  cancelDeletion(context: ActorContext): Promise<void> {
    return this.db.withActor(context, async (tx) => {
      const me = personOf(context);
      const [open] = await repo.openErasures(tx, [me]);
      if (!open || open.kind !== "account_deletion") throw new DomainError("not_found");
      if (!(await repo.cancelErasure(tx, open.id, me))) throw new DomainError("erasure_pending");
      await audit.record(tx, {
        action: "account.deletion.cancelled",
        resourceType: "erasure_request",
        resourceId: open.id,
      });
    });
  }

  /** The caller's scheduled account deletion, if any (GET /me). */
  pendingDeletion(context: ActorContext): Promise<{ scheduledFor: Date } | null> {
    return this.db.withActor(context, async (tx) => {
      const [open] = await repo.openErasures(tx, [personOf(context)]);
      return open?.kind === "account_deletion" ? { scheduledFor: open.scheduledFor } : null;
    });
  }

  private async wardInTx(tx: Tx, guardianId: string, wardId: string) {
    const ward = (await repo.wardLogins(tx, guardianId)).find((w) => w.wardPersonId === wardId);
    if (!ward) throw new DomainError("not_found");
    return ward;
  }

  /** What erasing a ward needs (the caller is a full guardian of the ward). */
  wardPreview(context: ActorContext, wardId: string): Promise<WardPreviewData> {
    return this.db.withActor(context, async (tx) => {
      const ward = await this.wardInTx(tx, personOf(context), wardId);
      const [pending] = await repo.openErasures(tx, [wardId]);
      return {
        graceDays: this.options.graceDays,
        hasLogin: ward.wardHasLogin,
        blockers: await erasureBlockersInTx(tx, [wardId], this.options.obligations),
        pending: pending ?? (await repo.includedInErasure(tx, wardId)),
      };
    });
  }

  /** Schedules a ward's erasure; the other full guardians are told and may cancel. */
  scheduleWardErasure(context: ActorContext, wardId: string): Promise<repo.ErasureRequestRow> {
    return this.db.withActor(context, async (tx) => {
      const me = personOf(context);
      const ward = await this.wardInTx(tx, me, wardId);
      if (ward.wardHasLogin) throw new DomainError("ward_has_login");
      if (
        (await repo.openErasures(tx, [wardId])).length > 0 ||
        (await repo.includedInErasure(tx, wardId))
      ) {
        throw new DomainError("erasure_pending");
      }
      const blockers = await erasureBlockersInTx(tx, [wardId], this.options.obligations);
      if (blockers.length > 0) throw new DomainError("erasure_blocked");
      const request = await repo.insertErasure(tx, {
        personId: wardId,
        requestedByPersonId: me,
        kind: "ward_erasure",
        scheduledFor: new Date(this.now().getTime() + this.options.graceDays * DAY_MS),
        includeWardIds: [],
      });
      if (!request) throw new DomainError("erasure_pending");
      await audit.record(tx, {
        action: "person.erasure.scheduled",
        resourceType: "erasure_request",
        resourceId: request.id,
      });
      await outbox.publish(tx, "privacy.erasure.scheduled", { requestId: request.id });
      return request;
    });
  }

  /** Cancels a ward's scheduled erasure (the requester or any full guardian of the ward). */
  cancelWardErasure(context: ActorContext, wardId: string): Promise<void> {
    return this.db.withActor(context, async (tx) => {
      const me = personOf(context);
      await this.wardInTx(tx, me, wardId);
      const [open] = await repo.openErasures(tx, [wardId]);
      if (!open || open.kind !== "ward_erasure") throw new DomainError("not_found");
      if (!(await repo.cancelErasure(tx, open.id, me))) throw new DomainError("erasure_pending");
      await audit.record(tx, {
        action: "person.erasure.cancelled",
        resourceType: "erasure_request",
        resourceId: open.id,
      });
    });
  }
}
