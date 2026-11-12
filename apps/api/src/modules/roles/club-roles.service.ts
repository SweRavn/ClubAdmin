// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles (P1.15 A2, ADR 0046): administrators create, change,
// copy and delete roles and assign them, without holding the permissions
// themselves (club.roles.manage). Locked roles keep their locked
// permissions and cannot be deleted. A change bumps the role's version and
// publishes role.updated: the worker invalidates every holder's relationship
// set (their next request is decided on the new permissions) and tells
// holders of removed permissions.

import {
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type CreateRoleInput,
  isRolePermission,
  LOCKED_ROLES,
  NON_POWERS,
  OWNER_PERMISSIONS,
  PERMISSION_CATALOGUE,
  type RolePermission,
  type RoleTexts,
  type UpdateRoleInput,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import type { Actor, GroupRef } from "../authorization/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./club-roles.repository.ts";
import type { RolesService } from "./roles.service.ts";

export type ClubRoleRow = repo.RoleRow;
export type ClubAssignmentRow = repo.ClubAssignmentRow;

/**
 * No escalation (P1.15 A2): without club.roles.manage, a group role may be
 * given only if every permission in it is one the caller holds in the group
 * (owners: what owning the group gives). Taking part and counting as a
 * leader are not powers.
 */
export function mayAssignGroupRole(
  actor: Actor,
  group: GroupRef,
  permissions: readonly string[],
): boolean {
  if (actor.holds("club.roles.manage", group.clubId)) return true;
  const owns = actor.ownsGroup(group);
  return permissions.every(
    (p) =>
      (NON_POWERS as readonly string[]).includes(p) ||
      (owns && (OWNER_PERMISSIONS as readonly string[]).includes(p)) ||
      (isRolePermission(p) && actor.holds(p, group)),
  );
}

/** Permissions a role may not lose (the locked roles, ADR 0018 and decision 12). */
export function lockedPermissionsOf(role: {
  locked: boolean;
  templateKey: string | null;
}): string[] {
  if (!role.locked || !role.templateKey) return [];
  return [...(LOCKED_ROLES[role.templateKey as keyof typeof LOCKED_ROLES] ?? [])];
}

const clean = (texts: RoleTexts | undefined | null): Record<string, string> | null => {
  if (!texts) return null;
  const entries = Object.entries(texts).filter(([, v]) => typeof v === "string" && v.length > 0);
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : null;
};

/** Permissions a role of the scope may hold: group roles only group permissions. */
function checkPermissions(scope: "club" | "group", permissions: readonly string[]): void {
  for (const p of permissions) {
    if (!isRolePermission(p)) throw new DomainError("invalid_input");
    const entry = PERMISSION_CATALOGUE[p];
    if (scope === "group" && entry.kind === "role" && entry.scope === "club") {
      throw new DomainError("permission_not_for_group_roles");
    }
  }
}

export class ClubRolesService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly roles: RolesService;

  constructor(db: Database, clubs: ClubsService, roles: RolesService) {
    this.db = db;
    this.clubs = clubs;
    this.roles = roles;
  }

  listRoles(context: TenantContext): Promise<{
    roles: ClubRoleRow[];
    selfAssignments: ClubAssignmentRow[];
    templates: Map<string, string[]>;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const [roles, selfAssignments] = await Promise.all([
        repo.listRoles(tx, context.clubId),
        repo.selfAssignments(tx, context.clubId),
      ]);
      return { roles, selfAssignments, templates: await this.templatesOf(tx, roles) };
    });
  }

  private async templatesOf(tx: Tx, roles: readonly ClubRoleRow[]): Promise<Map<string, string[]>> {
    const all = await repo.allTemplatePermissions(tx);
    const templates = new Map<string, string[]>();
    for (const r of roles) {
      if (r.templateKey) templates.set(r.id, all.get(`${r.scope}:${r.templateKey}`) ?? []);
    }
    return templates;
  }

  getRole(context: TenantContext, roleId: string): Promise<ClubRoleRow> {
    return this.db.withTenant(context, async (tx) => {
      const role = await repo.getRole(tx, context.clubId, roleId);
      if (!role) throw new DomainError("not_found");
      return role;
    });
  }

  /** A group role of the club: by ID, or the template role of an old function name. */
  groupRole(
    context: TenantContext,
    ref: { roleId?: string | undefined; templateKey: string },
  ): Promise<ClubRoleRow> {
    return this.db.withTenant(context, async (tx) => {
      const role = ref.roleId
        ? await repo.getRole(tx, context.clubId, ref.roleId)
        : await repo.templateRole(tx, context.clubId, "group", ref.templateKey);
      if (!role || role.scope !== "group") throw new DomainError("not_found");
      return role;
    });
  }

  /** The club's group roles (for choosing one in a group). */
  groupRoles(context: TenantContext): Promise<ClubRoleRow[]> {
    return this.db.withTenant(context, async (tx) =>
      (await repo.listRoles(tx, context.clubId)).filter((r) => r.scope === "group"),
    );
  }

  /** Roles by ID (the caller's own roles, "my roles"). */
  rolesByIds(context: TenantContext, ids: readonly string[]): Promise<ClubRoleRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.withTenant(context, async (tx) =>
      (await repo.listRoles(tx, context.clubId)).filter((r) => ids.includes(r.id)),
    );
  }

  /** A new role of the club (also "copy role": the client sends the copied permissions). */
  createRole(context: TenantContext, input: CreateRoleInput): Promise<ClubRoleRow> {
    return this.db.withTenant(context, async (tx) => {
      const permissions = [...new Set(input.permissions)];
      checkPermissions(input.scope, permissions);
      const names = clean(input.names);
      if (!names) throw new DomainError("invalid_input");
      const id = await repo.insertRole(tx, {
        clubId: context.clubId,
        scope: input.scope,
        names,
        descriptions: clean(input.descriptions),
      });
      await repo.addPermissions(tx, context.clubId, id, permissions);
      await audit.record(tx, {
        action: "role.created",
        resourceType: "role",
        resourceId: id,
        changedFields: ["names", "permissions"],
      });
      return (await repo.getRole(tx, context.clubId, id))!;
    });
  }

  /**
   * Changes a role's names and permissions (from the version the caller saw).
   * Locked permissions stay; a group role holds group permissions only.
   */
  updateRole(context: TenantContext, roleId: string, input: UpdateRoleInput): Promise<ClubRoleRow> {
    return this.db.withTenant(context, async (tx) => {
      const role = await repo.getRole(tx, context.clubId, roleId, true);
      if (!role) throw new DomainError("not_found");
      if (role.version !== input.version) throw new DomainError("role_changed");
      const changed: string[] = [];
      let next: string[] | undefined = input.permissions
        ? [...new Set(input.permissions)]
        : undefined;
      if (input.resetToTemplate) {
        if (!role.templateKey) throw new DomainError("invalid_input");
        next = await repo.templatePermissions(tx, role.scope, role.templateKey);
        await repo.updateRoleTexts(tx, roleId, { names: null, descriptions: null });
        changed.push("names", "descriptions");
      }
      if (next) {
        checkPermissions(role.scope, next);
        const missingLocked = lockedPermissionsOf(role).filter((p) => !next.includes(p));
        if (missingLocked.length > 0) throw new DomainError("role_locked");
        const added = next.filter((p) => !role.permissions.includes(p));
        const removed = role.permissions.filter((p) => !next.includes(p));
        if (added.length > 0 || removed.length > 0) {
          await repo.addPermissions(tx, context.clubId, roleId, added);
          await repo.removePermissions(tx, roleId, removed);
          changed.push("permissions");
          await outbox.publish(tx, "role.updated", {
            clubId: context.clubId,
            roleId,
            added,
            removed,
          });
        }
      }
      if (
        !input.resetToTemplate &&
        (input.names !== undefined || input.descriptions !== undefined)
      ) {
        const texts: {
          names?: Record<string, string> | null;
          descriptions?: Record<string, string> | null;
        } = {};
        if (input.names !== undefined) {
          const names = clean(input.names);
          // A club's own role always has a name; a template role may fall back to the catalogue's.
          if (!names && !role.templateKey) throw new DomainError("invalid_input");
          texts.names = names;
          changed.push("names");
        }
        if (input.descriptions !== undefined) {
          texts.descriptions = clean(input.descriptions);
          changed.push("descriptions");
        }
        await repo.updateRoleTexts(tx, roleId, texts);
      }
      if (changed.length > 0) {
        await repo.bumpVersion(tx, roleId);
        await audit.record(tx, {
          action: "role.updated",
          resourceType: "role",
          resourceId: roleId,
          changedFields: [...new Set(changed)],
        });
      }
      return (await repo.getRole(tx, context.clubId, roleId))!;
    });
  }

  /**
   * The effect of giving a role these permissions (no write): what is added
   * and removed, and per removed permission the holders who no longer hold
   * it through any other role.
   */
  previewRole(
    context: TenantContext,
    roleId: string,
    permissions: readonly string[],
  ): Promise<{
    added: string[];
    removed: string[];
    holderCount: number;
    losing: { permission: string; personIds: string[] }[];
  }> {
    return this.db.withTenant(context, async (tx) => {
      const role = await repo.getRole(tx, context.clubId, roleId);
      if (!role) throw new DomainError("not_found");
      const next = [...new Set(permissions)];
      checkPermissions(role.scope, next);
      const added = next.filter((p) => !role.permissions.includes(p));
      const removed = role.permissions.filter((p) => !next.includes(p));
      const holders = await repo.holdersOfRole(tx, context.clubId, roleId);
      const people = [...new Set(holders.map((h) => h.personId))];
      const others = removed.length
        ? await repo.otherPermissionsOf(tx, context.clubId, people, roleId)
        : new Map<string, Set<string>>();
      return {
        added,
        removed,
        holderCount: people.length,
        losing: removed.map((permission) => ({
          permission,
          personIds: people.filter((id) => !others.get(id)?.has(permission)),
        })),
      };
    });
  }

  /**
   * Deletes a role (it is archived: history keeps it and its assignments).
   * Its holders move to `replacementRoleId` (same scope), or their
   * assignments end. Locked roles cannot be deleted.
   */
  deleteRole(
    context: TenantContext,
    roleId: string,
    replacementRoleId: string | undefined,
  ): Promise<{ moved: number; ended: number }> {
    return this.db.withTenant(context, async (tx) => {
      const role = await repo.getRole(tx, context.clubId, roleId, true);
      if (!role) throw new DomainError("not_found");
      if (role.locked) throw new DomainError("role_locked");
      let moved: { personId: string }[] = [];
      if (replacementRoleId) {
        const replacement = await repo.getRole(tx, context.clubId, replacementRoleId);
        if (!replacement || replacement.id === roleId || replacement.scope !== role.scope) {
          throw new DomainError("invalid_replacement_role");
        }
        moved = await repo.moveHolders(tx, context.clubId, roleId, replacementRoleId);
      }
      const ended = await repo.endHolders(tx, context.clubId, roleId, context.personId ?? null);
      await repo.archiveRole(tx, roleId);
      await audit.record(tx, {
        action: "role.deleted",
        resourceType: "role",
        resourceId: roleId,
        changedFields: ["archived_at"],
      });
      const event = role.scope === "club" ? "role.changed" : "membership.changed";
      for (const personId of new Set([...moved, ...ended].map((h) => h.personId))) {
        await outbox.publish(tx, event, { clubId: context.clubId, personId });
      }
      return { moved: moved.length, ended: ended.length };
    });
  }

  holdersOfPermission(
    context: TenantContext,
    permission: RolePermission,
    page: { cursor: string | null; limit: number },
  ): Promise<{ personId: string; roleIds: string[]; groupIds: string[] }[]> {
    return this.db.withTenant(context, (tx) =>
      repo.holdersOfPermission(tx, context.clubId, permission, page),
    );
  }

  assignmentsOfPerson(context: TenantContext, personId: string): Promise<ClubAssignmentRow[]> {
    return this.db.withTenant(context, (tx) =>
      repo.assignmentsOfPerson(tx, context.clubId, personId),
    );
  }

  /**
   * Gives a person a club role (club.roles.manage: any role, also one the
   * caller does not hold; also to themselves, which is told to the other
   * administrators and the chair).
   */
  /**
   * The club's roles with their permissions (no holder counts), in the
   * caller's transaction or a new one: invitations choose and check roles
   * by these (P1.15 A4).
   */
  rolesOfClub(context: TenantContext): Promise<ClubRoleRow[]> {
    return this.db.withTenant(context, (tx) => repo.rolesOfClub(tx, context.clubId));
  }

  rolesOfClubInTx(tx: Tx, clubId: string): Promise<ClubRoleRow[]> {
    return repo.rolesOfClub(tx, clubId);
  }

  assignClubRole(
    context: TenantContext,
    personId: string,
    roleId: string,
  ): Promise<ClubAssignmentRow> {
    return this.db.withTenant(context, (tx) =>
      this.assignClubRoleInTx(tx, context, personId, roleId),
    );
  }

  /**
   * Assigns a club role in the caller's transaction. `invited`: the person
   * accepts an invitation that gives the role (P1.15 A4), which is not a
   * self-assignment even though they are the actor.
   */
  async assignClubRoleInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    roleId: string,
    options: { invited?: boolean } = {},
  ): Promise<ClubAssignmentRow> {
    const role = await repo.getRole(tx, context.clubId, roleId);
    if (!role || role.scope !== "club") throw new DomainError("not_found");
    if (role.permissions.includes("club.roles.manage")) {
      await this.clubs.lockClubInTx(tx, context.clubId);
    }
    let assignment: ClubAssignmentRow;
    try {
      assignment = await repo.insertAssignment(tx, {
        clubId: context.clubId,
        personId,
        roleId,
        assignedByPersonId: context.personId ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error, "club_role_assignments_open_unique")) {
        throw new DomainError("role_already_assigned");
      }
      throw error;
    }
    await audit.record(tx, {
      action: "role.assigned",
      resourceType: "club_role_assignment",
      resourceId: assignment.id,
      changedFields: ["role_id"],
    });
    await outbox.publish(tx, "role.changed", { clubId: context.clubId, personId });
    if (personId === actorPersonId(context) && !options.invited) {
      await outbox.publish(tx, "role.self_assigned", {
        clubId: context.clubId,
        personId,
        roleId,
      });
    }
    return assignment;
  }

  /** Ends a club role assignment (the last club manager is refused, ADR 0018). */
  unassign(context: TenantContext, assignmentId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const ended = await this.roles.endAssignmentByIdInTx(tx, context, assignmentId);
      if (!ended) throw new DomainError("not_found");
      await outbox.publish(tx, "role.unassigned", {
        clubId: context.clubId,
        personId: ended.personId,
        roleId: ended.roleId!, // NOT NULL in the database (migration 0032)
      });
      await audit.record(tx, {
        action: "role.unassigned",
        resourceType: "club_role_assignment",
        resourceId: assignmentId,
        changedFields: ["valid_to"],
      });
    });
  }
}
