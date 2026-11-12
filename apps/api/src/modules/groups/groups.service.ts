// SPDX-License-Identifier: AGPL-3.0-only
// Groups (ADR 0019): kinds, hierarchy (same club, no cycles; enforced by the
// database), admission mode and capacity, and group owners. Groups are
// archived; only a group that was never used can be deleted (P1.6b).

import {
  type ActorContext,
  audit,
  type Database,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  outbox,
  savepoint,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type CreateGroupInput,
  CreateGroupSchema,
  type UpdateGroupInput,
  UpdateGroupSchema,
  uuidv7,
  type WaitlistClosedReason,
  z,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, definedOnly, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import { GroupWaitlist, type OwnEntryRow, type PositionRow } from "./group-waitlist.ts";
import * as repo from "./groups.repository.ts";

export type Group = repo.GroupRow;
export type Season = repo.SeasonRow;

/**
 * Who allows an owner change. Authorization (P0.7) decides which applies to
 * the actor; the service enforces what each implies.
 * - club_manager: club managers can always assign and remove owners;
 * - group_owner: an owner of the group (or a parent group), only if the club
 *   setting owners_can_appoint_co_owners is on.
 */
export type OwnerChangeAllowedBy = "club_manager" | "group_owner";

function translateWriteError(error: unknown): never {
  if (isCheckViolation(error, "groups_no_cycle")) throw new DomainError("group_cycle");
  if (
    isForeignKeyViolation(error, "groups_parent_same_club_fk") ||
    isCheckViolation(error, "groups_not_own_parent")
  ) {
    throw new DomainError("group_parent_invalid");
  }
  throw error;
}

const SeasonSchema = z.object({
  name: z.string().trim().min(1).max(50),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
});

export class GroupsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  /** Waiting-list entries (P1.10b): status changes with their audit and outbox events. */
  readonly waitlist = new GroupWaitlist();

  constructor(db: Database, clubs: ClubsService) {
    this.db = db;
    this.clubs = clubs;
  }

  /** `id`: a fixed group ID (the demo seed; ADR 0026). */
  createGroup(
    context: TenantContext,
    input: CreateGroupInput,
    options: { id?: string } = {},
  ): Promise<Group> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(CreateGroupSchema, input));
      if (data.parentGroupId) await this.requireVisibleGroup(tx, data.parentGroupId);
      const group = await repo
        .insertGroup(tx, {
          ...data,
          name: data.name!,
          kind: data.kind!,
          id: options.id ?? uuidv7(),
          clubId: context.clubId,
        })
        .catch(translateWriteError);
      await audit.record(tx, {
        action: "group.created",
        resourceType: "group",
        resourceId: group.id,
        changedFields: Object.keys(data),
      });
      if (group.parentGroupId) {
        await outbox.publish(tx, "group.parent.changed", {
          clubId: context.clubId,
          groupId: group.id,
        });
      }
      return group;
    });
  }

  getGroup(context: TenantContext, groupId: string): Promise<Group> {
    return this.db.withTenant(context, (tx) => this.getGroupInTx(tx, groupId));
  }

  /**
   * A group, the IDs of its current owners and the number waiting, in one
   * transaction; with `manage` also its places today and whether it can be
   * deleted (P1.10a).
   */
  getGroupWithOwners(
    context: TenantContext,
    groupId: string,
    options: { manage?: boolean } = {},
  ): Promise<{
    group: Group;
    ownerIds: string[];
    waitingCount: number;
    capacity?: repo.GroupCapacity;
    deletable?: boolean;
  }> {
    return this.db.withTenant(context, async (tx) => ({
      group: await this.getGroupInTx(tx, groupId),
      ownerIds: await repo.activeOwners(tx, groupId),
      waitingCount: await repo.waitingCountOf(tx, groupId),
      ...(options.manage
        ? {
            capacity: await repo.capacityOf(tx, groupId),
            deletable: !(await repo.isInUse(tx, groupId)),
          }
        : {}),
    }));
  }

  /** Groups of the club by ID (for "my groups"). */
  findGroups(context: TenantContext, groupIds: readonly string[]): Promise<Group[]> {
    return this.db.withTenant(context, (tx) => repo.findGroups(tx, groupIds));
  }

  async getGroupInTx(tx: Tx, groupId: string): Promise<Group> {
    const group = await repo.findGroup(tx, groupId);
    if (!group) throw new DomainError("not_found");
    return group;
  }

  /** A page of the club's groups by name; archived ones only with includeArchived. */
  listGroups(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number; includeArchived: boolean },
  ): Promise<{ items: Group[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const { rows, cursorFound } = await repo.listGroupsPage(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
        includeArchived: page.includeArchived,
      });
      if (!cursorFound) throw new DomainError("invalid_cursor");
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** The club's active groups by name (id, name, kind), all of them (invitations, P1.15 A4). */
  activeGroups(
    context: TenantContext,
  ): Promise<{ id: string; name: string; kind: Group["kind"] }[]> {
    return this.db.withTenant(context, (tx) => repo.activeGroupsOfClub(tx, context.clubId));
  }

  /** The club's groups that are not archived, by lower-cased name (imports match groups by name, P1.3b). */
  async groupIdsByNameInTx(tx: Tx, clubId: string): Promise<Map<string, string>> {
    const rows = await repo.activeGroupNames(tx, clubId);
    return new Map(rows.map((g) => [g.name.trim().toLowerCase(), g.id]));
  }

  /** Groups visible to the transaction, by ID. */
  findGroupsInTx(tx: Tx, groupIds: readonly string[]): Promise<Group[]> {
    return repo.findGroups(tx, groupIds);
  }

  /** Ends the person's group ownerships in the club (leaving the club). */
  async endOwnershipsOfPersonInTx(tx: Tx, context: TenantContext, personId: string): Promise<void> {
    for (const ownerId of await repo.endOwnershipsOfPerson(tx, context.clubId, personId)) {
      await audit.record(tx, {
        action: "group.owner.removed",
        resourceType: "group_owner",
        resourceId: ownerId,
      });
    }
  }

  /**
   * Ends one of the person's group ownerships by its ID (stepping down,
   * P1.8a); false if it is not theirs or not open.
   */
  async endOwnershipOfPersonInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    ownershipId: string,
  ): Promise<boolean> {
    const groupId = await repo.endOwnershipOfPerson(tx, context.clubId, personId, ownershipId);
    if (!groupId) return false;
    await audit.record(tx, {
      action: "group.owner.removed",
      resourceType: "group_owner",
      resourceId: ownershipId,
    });
    await outbox.publish(tx, "group.owner.changed", { clubId: context.clubId, groupId, personId });
    return true;
  }

  /** The person's open group ownerships in the club (P1.8a). */
  ownershipsOfPersonInTx(
    tx: Tx,
    clubId: string,
    personId: string,
  ): Promise<{ id: string; groupId: string }[]> {
    return repo.ownershipsOfPerson(tx, clubId, personId);
  }

  /** Withdraws the person's open waiting-list entries in the club (leaving, P1.8a). */
  async withdrawWaitlistEntriesOfPersonInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
  ): Promise<number> {
    const ids = await repo.withdrawWaitlistEntriesOfPerson(tx, context.clubId, personId);
    for (const id of ids) {
      await audit.record(tx, {
        action: "group.waitlist.withdrawn",
        resourceType: "group_waitlist_entry",
        resourceId: id,
        changedFields: ["status"],
      });
    }
    return ids.length;
  }

  updateGroup(context: TenantContext, groupId: string, patch: UpdateGroupInput): Promise<Group> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(UpdateGroupSchema, patch));
      const current = await repo.lockGroup(tx, groupId);
      if (!current) throw new DomainError("not_found");
      if (current.archivedAt) throw new DomainError("group_archived");
      if (data.parentGroupId) await this.requireVisibleGroup(tx, data.parentGroupId);
      const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
        (k) => data[k] !== current[k],
      );
      if (changed.length === 0) return current;
      await repo.updateGroup(tx, groupId, data).catch(translateWriteError);
      await audit.record(tx, {
        action: "group.updated",
        resourceType: "group",
        resourceId: groupId,
        changedFields: changed,
      });
      if (changed.includes("parentGroupId")) {
        await outbox.publish(tx, "group.parent.changed", { clubId: context.clubId, groupId });
      }
      return this.getGroupInTx(tx, groupId);
    });
  }

  /**
   * Archives the group in the caller's transaction (P1.10a; the memberships
   * module ends the memberships in the same transaction); refused while it
   * has child groups that are not archived. False if it was archived already.
   */
  async archiveGroupInTx(tx: Tx, groupId: string): Promise<boolean> {
    const current = await repo.lockGroup(tx, groupId);
    if (!current) throw new DomainError("not_found");
    if (current.archivedAt) return false;
    if (await repo.hasActiveChildren(tx, groupId)) throw new DomainError("group_has_children");
    await repo.updateGroup(tx, groupId, { archivedAt: new Date() });
    await audit.record(tx, {
      action: "group.archived",
      resourceType: "group",
      resourceId: groupId,
      changedFields: ["archived_at"],
    });
    return true;
  }

  /**
   * Closes the group's open waiting-list entries (archiving, P1.10a): each
   * becomes `removed` with the reason, is audited, and the applicant is told
   * (`waitlist.entry.closed`). The number closed.
   */
  async closeWaitlistOfGroupInTx(
    tx: Tx,
    context: TenantContext,
    groupId: string,
    reason: WaitlistClosedReason,
  ): Promise<number> {
    const ids = await repo.closeOpenWaitlistEntries(tx, groupId, reason, context.personId ?? null);
    for (const entryId of ids) {
      await audit.record(tx, {
        action: "group.waitlist.closed",
        resourceType: "group_waitlist_entry",
        resourceId: entryId,
        changedFields: ["status", "closed_reason"],
      });
      await outbox.publish(tx, "waitlist.entry.closed", { clubId: context.clubId, entryId });
    }
    return ids.length;
  }

  /** What archiving would close here: open waiting-list entries and active child groups. */
  async archiveFactsInTx(
    tx: Tx,
    groupId: string,
  ): Promise<{ waitlist: number; activeChildren: number }> {
    return {
      waitlist: await repo.openWaitlistCount(tx, groupId),
      activeChildren: await repo.activeChildrenCount(tx, groupId),
    };
  }

  /** The group locked for a capacity check (adding a member, P1.10a). */
  async lockGroupInTx(tx: Tx, groupId: string): Promise<Group> {
    const group = await repo.lockGroup(tx, groupId);
    if (!group) throw new DomainError("not_found");
    return group;
  }

  /** The group's places today and how many are taken (P1.10a). */
  capacityInTx(tx: Tx, groupId: string): Promise<repo.GroupCapacity> {
    return repo.capacityOf(tx, groupId);
  }

  /** Restores an archived group (the caller checked that a club manager asks). */
  restoreGroup(context: TenantContext, groupId: string): Promise<Group> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockGroup(tx, groupId);
      if (!current) throw new DomainError("not_found");
      if (!current.archivedAt) return current;
      await repo.updateGroup(tx, groupId, { archivedAt: null });
      await audit.record(tx, {
        action: "group.restored",
        resourceType: "group",
        resourceId: groupId,
      });
      return this.getGroupInTx(tx, groupId);
    });
  }

  /**
   * Deletes a group that was never used (P1.6b): no memberships, owners,
   * activities, events, waiting-list entries, invitations or child groups,
   * ever. Everything else is archived instead (`group_in_use`).
   */
  deleteGroup(context: TenantContext, groupId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockGroup(tx, groupId);
      if (!current) throw new DomainError("not_found");
      if (await repo.isInUse(tx, groupId)) throw new DomainError("group_in_use");
      await savepoint(tx, () => repo.deleteGroup(tx, groupId)).catch((error: unknown) => {
        if (isForeignKeyViolation(error)) throw new DomainError("group_in_use");
        throw error;
      });
      await audit.record(tx, {
        action: "group.deleted",
        resourceType: "group",
        resourceId: groupId,
      });
    });
  }

  /**
   * The waiting-list entries of the given people (the caller and their
   * wards), open ones and those closed in the last 12 months, with their
   * place in the queue (P1.6b, P1.10b). One transaction as the actor: the
   * entries through own_relationships, the positions and names through
   * app.waitlist_positions (the applicant cannot read the club's other
   * entries or, before admission, its groups).
   */
  myWaitlistEntries(
    context: ActorContext,
    personIds: readonly string[],
  ): Promise<(OwnEntryRow & PositionRow)[]> {
    return this.db.withActor(context, async (tx) => {
      const own = await this.waitlist.ownEntriesInTx(tx, personIds);
      const queue = await this.waitlist.positionsInTx(
        tx,
        own.map((e) => e.id),
      );
      return own.flatMap((e) => {
        const q = queue.get(e.id);
        return q ? [{ ...e, ...q }] : [];
      });
    });
  }

  /** Whether the group was never used and can be deleted. */
  isDeletable(context: TenantContext, groupId: string): Promise<boolean> {
    return this.db.withTenant(context, async (tx) => !(await repo.isInUse(tx, groupId)));
  }

  /** The group and its ancestors, nearest first (ownership of a parent includes its children). */
  ancestorIdsInTx(tx: Tx, groupId: string): Promise<string[]> {
    return repo.ancestorIds(tx, groupId);
  }

  /** Owner of the group itself or of one of its parent groups. */
  async isOwnerInTx(tx: Tx, groupId: string, personId: string): Promise<boolean> {
    return repo.isOwnerOfAny(tx, await repo.ancestorIds(tx, groupId), personId);
  }

  owners(context: TenantContext, groupId: string): Promise<string[]> {
    return this.db.withTenant(context, (tx) => repo.activeOwners(tx, groupId));
  }

  addOwner(
    context: TenantContext,
    groupId: string,
    personId: string,
    allowedBy: OwnerChangeAllowedBy,
  ): Promise<void> {
    return this.db.withTenant(context, (tx) =>
      this.addOwnerInTx(tx, context, groupId, personId, allowedBy),
    );
  }

  /** Adds an owner in the caller's transaction (the caller checked eligibility, P1.10a). */
  async addOwnerInTx(
    tx: Tx,
    context: TenantContext,
    groupId: string,
    personId: string,
    allowedBy: OwnerChangeAllowedBy,
  ): Promise<void> {
    {
      const group = await this.requireVisibleGroup(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      await this.checkOwnerChange(tx, context, groupId, allowedBy);
      let ownerId: string;
      try {
        ({ id: ownerId } = await repo.insertOwner(tx, {
          clubId: context.clubId,
          groupId,
          personId,
          assignedByPersonId: context.personId ?? null,
        }));
      } catch (error) {
        if (isUniqueViolation(error, "group_owners_open_unique"))
          throw new DomainError("already_group_owner");
        throw error;
      }
      await audit.record(tx, {
        action: "group.owner.added",
        resourceType: "group_owner",
        resourceId: ownerId,
      });
      await outbox.publish(tx, "group.owner.changed", {
        clubId: context.clubId,
        groupId,
        personId,
      });
    }
  }

  removeOwner(
    context: TenantContext,
    groupId: string,
    personId: string,
    allowedBy: OwnerChangeAllowedBy,
  ): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      await this.requireVisibleGroup(tx, groupId);
      await this.checkOwnerChange(tx, context, groupId, allowedBy);
      const ownerId = await repo.endOwner(tx, groupId, personId);
      if (!ownerId) throw new DomainError("not_found");
      await audit.record(tx, {
        action: "group.owner.removed",
        resourceType: "group_owner",
        resourceId: ownerId,
      });
      await outbox.publish(tx, "group.owner.changed", {
        clubId: context.clubId,
        groupId,
        personId,
      });
    });
  }

  /** The club's seasons, newest first (P1.10a). */
  listSeasons(context: TenantContext): Promise<Season[]> {
    return this.db.withTenant(context, (tx) => repo.listSeasons(tx, context.clubId));
  }

  /** The group's per-season settings (P1.10a). */
  groupSeasons(
    context: TenantContext,
    groupId: string,
  ): Promise<{ seasonId: string; capacity: number | null; notes: string | null }[]> {
    return this.db.withTenant(context, (tx) => repo.groupSeasonsOf(tx, groupId));
  }

  createSeason(context: TenantContext, input: z.input<typeof SeasonSchema>): Promise<Season> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SeasonSchema, input);
      if (data.endsOn <= data.startsOn) throw new DomainError("invalid_input");
      const season = await repo.insertSeason(tx, { ...data, clubId: context.clubId });
      await audit.record(tx, {
        action: "group.updated",
        resourceType: "season",
        resourceId: season.id,
      });
      return season;
    });
  }

  /** Per-season settings of a group. */
  setGroupSeason(
    context: TenantContext,
    groupId: string,
    seasonId: string,
    settings: { capacity?: number | null; notes?: string | null },
  ): Promise<string> {
    return this.db.withTenant(context, async (tx) => {
      const group = await this.requireVisibleGroup(tx, groupId);
      if (group.archivedAt) throw new DomainError("group_archived");
      // Seasons of other clubs are invisible (RLS).
      if (!(await repo.findSeason(tx, seasonId))) throw new DomainError("not_found");
      const id = await repo.upsertGroupSeason(tx, {
        clubId: context.clubId,
        groupId,
        seasonId,
        ...settings,
      });
      await audit.record(tx, {
        action: "group.updated",
        resourceType: "group_season",
        resourceId: id,
        changedFields: Object.keys(settings),
      });
      return id;
    });
  }

  private async requireVisibleGroup(tx: Tx, groupId: string): Promise<Group> {
    const group = await repo.findGroup(tx, groupId);
    // Groups of other clubs are invisible (RLS), so they look like a missing parent.
    if (!group) throw new DomainError("group_parent_invalid");
    return group;
  }

  private async checkOwnerChange(
    tx: Tx,
    context: TenantContext,
    groupId: string,
    allowedBy: OwnerChangeAllowedBy,
  ): Promise<void> {
    if (allowedBy === "club_manager") return;
    const club = await this.clubs.getClubInTx(tx, context.clubId);
    if (!club.ownersCanAppointCoOwners) throw new DomainError("not_allowed");
    if (!(await this.isOwnerInTx(tx, groupId, actorPersonId(context))))
      throw new DomainError("not_allowed");
  }
}
