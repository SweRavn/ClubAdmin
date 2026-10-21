// SPDX-License-Identifier: AGPL-3.0-only
// Groups (ADR 0019): kinds, hierarchy (same club, no cycles; enforced by the
// database), admission mode and capacity, and group owners. Groups are
// archived, never deleted.

import {
  audit,
  type Database,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type CreateGroupInput,
  CreateGroupSchema,
  type UpdateGroupInput,
  UpdateGroupSchema,
  uuidv7,
  z,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, definedOnly, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
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

  constructor(db: Database, clubs: ClubsService) {
    this.db = db;
    this.clubs = clubs;
  }

  createGroup(context: TenantContext, input: CreateGroupInput): Promise<Group> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(CreateGroupSchema, input));
      if (data.parentGroupId) await this.requireVisibleGroup(tx, data.parentGroupId);
      const group = await repo
        .insertGroup(tx, {
          ...data,
          name: data.name!,
          kind: data.kind!,
          id: uuidv7(),
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

  archiveGroup(context: TenantContext, groupId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockGroup(tx, groupId);
      if (!current) throw new DomainError("not_found");
      if (current.archivedAt) return;
      await repo.updateGroup(tx, groupId, { archivedAt: new Date() });
      await audit.record(tx, {
        action: "group.archived",
        resourceType: "group",
        resourceId: groupId,
      });
    });
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
    return this.db.withTenant(context, async (tx) => {
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
    });
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
      await this.requireVisibleGroup(tx, groupId);
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
