// SPDX-License-Identifier: AGPL-3.0-only
// Club types and their templates (P1.15 B, ADR 0046). Everyone logged in
// reads the active types (creating a club); operators create and edit types
// and their roles. A new type starts with the roles every type needs
// (REQUIRED_TEMPLATE_ROLES, copied from the built-in type), which can be
// renamed and given more permissions but not lose the required ones or be
// removed. Templates never change clubs (decision 6): a club gets a copy
// when it is created and copies single roles later.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  BUILT_IN_CLUB_TYPE,
  type CreateClubTypeInput,
  type CreateClubTypeRoleInput,
  CreateClubTypeRoleSchema,
  CreateClubTypeSchema,
  hasCatalogueName,
  REQUIRED_TEMPLATE_ROLES,
  templatePermissionProblem,
  type UpdateClubTypeInput,
  type UpdateClubTypeRoleInput,
  UpdateClubTypeRoleSchema,
  UpdateClubTypeSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { parseInput } from "../../platform/domain/run.ts";
import * as repo from "./club-types.repository.ts";

export type ClubTypeRow = repo.ClubTypeRow;
export type TemplateRoleRow = repo.TemplateRoleRow;

const requirementOf = (role: { scope: string; key: string }) =>
  REQUIRED_TEMPLATE_ROLES.find((r) => r.scope === role.scope && r.key === role.key);

/** Whether the role is one every type must have. */
export const isRequiredRole = (role: { scope: string; key: string }): boolean =>
  requirementOf(role) !== undefined;

const clean = (texts: Record<string, string | undefined> | null | undefined) => {
  if (!texts) return null;
  const entries = Object.entries(texts).filter(([, v]) => typeof v === "string" && v.length > 0);
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : null;
};

function checkPermissions(scope: "club" | "group", permissions: readonly string[]): void {
  const problem = templatePermissionProblem(scope, permissions);
  if (problem) throw new DomainError(problem);
}

export class ClubTypesService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** The active types with their roles (the club creation form). */
  activeTypes(context: ActorContext): Promise<ClubTypeRow[]> {
    return this.db.withActor(context, (tx) => repo.listTypes(tx, { activeOnly: true }));
  }

  /** Every type, active or not (operators). */
  allTypes(context: ActorContext): Promise<ClubTypeRow[]> {
    return this.db.withActor(context, (tx) => repo.listTypes(tx, { activeOnly: false }));
  }

  getType(context: ActorContext, id: string): Promise<ClubTypeRow> {
    return this.db.withActor(context, async (tx) => {
      const type = await repo.getType(tx, id);
      if (!type) throw new DomainError("not_found");
      return type;
    });
  }

  /**
   * The type a new club gets: the chosen one (it must be active), else the
   * country pack's default, else the built-in type.
   */
  async typeForNewClubInTx(tx: Tx, chosen: string | undefined, country: string): Promise<string> {
    if (chosen) {
      const type = await repo.typeRef(tx, { id: chosen });
      if (!type?.active) throw new DomainError("club_type_unavailable");
      return type.id;
    }
    const fallback = isSupportedCountry(country)
      ? getCountryPack(country).defaultClubType
      : undefined;
    if (fallback) {
      const type = await repo.typeRef(tx, { key: fallback });
      if (type?.active) return type.id;
    }
    const builtIn = await repo.typeRef(tx, { key: BUILT_IN_CLUB_TYPE });
    if (!builtIn) throw new Error("the built-in club type is missing (migration 0036)");
    return builtIn.id;
  }

  /** The club's type with its template, in the club's transaction. */
  typeOfClubInTx(tx: Tx, clubId: string): Promise<ClubTypeRow | null> {
    return repo.typeOfClub(tx, clubId);
  }

  typeOfClub(context: TenantContext): Promise<ClubTypeRow | null> {
    return this.db.withTenant(context, (tx) => repo.typeOfClub(tx, context.clubId));
  }

  /** A new type with the required roles of the built-in type (operators). */
  async createType(context: ActorContext, input: CreateClubTypeInput): Promise<ClubTypeRow> {
    const data = parseInput(CreateClubTypeSchema, input);
    return this.db.withActor(context, async (tx) => {
      let id: string;
      try {
        id = await repo.insertType(tx, {
          key: data.key,
          names: data.names,
          descriptions: clean(data.descriptions),
          sortOrder: data.sortOrder ?? 100,
        });
      } catch (error) {
        if (isUniqueViolation(error, "club_types_key_unique")) {
          throw new DomainError("club_type_exists");
        }
        throw error;
      }
      const builtIn = (await repo.listTypes(tx, { activeOnly: false })).find(
        (t) => t.key === BUILT_IN_CLUB_TYPE,
      );
      for (const required of REQUIRED_TEMPLATE_ROLES) {
        const source = builtIn?.roles.find(
          (r) => r.scope === required.scope && r.key === required.key,
        );
        const roleId = await repo.insertRole(tx, {
          clubTypeId: id,
          key: required.key,
          scope: required.scope,
          names: source?.names ?? null,
          descriptions: source?.descriptions ?? null,
          locked: required.locked,
          sortOrder: source?.sortOrder ?? 0,
        });
        await repo.setRolePermissions(tx, roleId, source?.permissions ?? required.permissions);
      }
      await audit.record(tx, {
        action: "club_type.created",
        resourceType: "club_type",
        resourceId: id,
        changedFields: ["key", "names", "descriptions", "roles"],
      });
      return (await repo.getType(tx, id))!;
    });
  }

  /** Renames, describes, (de)activates or reorders a type; the built-in type stays active. */
  async updateType(
    context: ActorContext,
    id: string,
    input: UpdateClubTypeInput,
  ): Promise<ClubTypeRow> {
    const data = parseInput(UpdateClubTypeSchema, input);
    return this.db.withActor(context, async (tx) => {
      const type = await repo.getType(tx, id);
      if (!type) throw new DomainError("not_found");
      if (data.active === false && type.key === BUILT_IN_CLUB_TYPE) {
        throw new DomainError("club_type_built_in");
      }
      await repo.updateType(tx, id, {
        ...(data.names ? { names: data.names } : {}),
        ...(data.descriptions !== undefined ? { descriptions: clean(data.descriptions) } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      });
      await audit.record(tx, {
        action: "club_type.updated",
        resourceType: "club_type",
        resourceId: id,
        changedFields: Object.keys(data).map((k) => (k === "sortOrder" ? "sort_order" : k)),
      });
      return (await repo.getType(tx, id))!;
    });
  }

  /** Adds a role to a type's template; a key without a catalogue name needs names. */
  async createRole(
    context: ActorContext,
    typeId: string,
    input: CreateClubTypeRoleInput,
  ): Promise<ClubTypeRow> {
    const data = parseInput(CreateClubTypeRoleSchema, input);
    const permissions = [...new Set(data.permissions)];
    checkPermissions(data.scope, permissions);
    if (!data.names && !hasCatalogueName(data.scope, data.key)) {
      throw new DomainError("club_type_role_names_required");
    }
    return this.db.withActor(context, async (tx) => {
      const type = await repo.getType(tx, typeId);
      if (!type) throw new DomainError("not_found");
      let roleId: string;
      try {
        roleId = await repo.insertRole(tx, {
          clubTypeId: typeId,
          key: data.key,
          scope: data.scope,
          names: data.names ?? null,
          descriptions: clean(data.descriptions),
          locked: false,
          sortOrder: data.sortOrder ?? Math.max(0, ...type.roles.map((r) => r.sortOrder)) + 1,
        });
      } catch (error) {
        if (isUniqueViolation(error, "club_type_roles_key_unique")) {
          throw new DomainError("club_type_role_exists");
        }
        throw error;
      }
      await repo.setRolePermissions(tx, roleId, permissions);
      await audit.record(tx, {
        action: "club_type.role.created",
        resourceType: "club_type_role",
        resourceId: roleId,
        changedFields: ["key", "scope", "names", "permissions"],
      });
      return (await repo.getType(tx, typeId))!;
    });
  }

  /** Renames a template role or changes its permissions; required permissions stay. */
  async updateRole(
    context: ActorContext,
    typeId: string,
    roleId: string,
    input: UpdateClubTypeRoleInput,
  ): Promise<ClubTypeRow> {
    const data = parseInput(UpdateClubTypeRoleSchema, input);
    return this.db.withActor(context, async (tx) => {
      const type = await repo.getType(tx, typeId);
      const role = type?.roles.find((r) => r.id === roleId);
      if (!type || !role) throw new DomainError("not_found");
      if (data.names === null && !hasCatalogueName(role.scope, role.key)) {
        throw new DomainError("club_type_role_names_required");
      }
      const changed: string[] = [];
      if (data.permissions) {
        const permissions = [...new Set(data.permissions)];
        checkPermissions(role.scope, permissions);
        const required = requirementOf(role)?.permissions ?? [];
        if (required.some((p) => !permissions.includes(p))) {
          throw new DomainError("club_type_role_required");
        }
        await repo.setRolePermissions(tx, roleId, permissions);
        changed.push("permissions");
      }
      if (data.names !== undefined || data.descriptions !== undefined || data.sortOrder) {
        await repo.updateRole(tx, roleId, {
          ...(data.names !== undefined ? { names: data.names } : {}),
          ...(data.descriptions !== undefined ? { descriptions: clean(data.descriptions) } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        });
        if (data.names !== undefined) changed.push("names");
        if (data.descriptions !== undefined) changed.push("descriptions");
        if (data.sortOrder !== undefined) changed.push("sort_order");
      }
      if (changed.length > 0) {
        await audit.record(tx, {
          action: "club_type.role.updated",
          resourceType: "club_type_role",
          resourceId: roleId,
          changedFields: changed,
        });
      }
      return (await repo.getType(tx, typeId))!;
    });
  }

  /** Removes a role from a type's template (not a required one; clubs keep their copies). */
  deleteRole(context: ActorContext, typeId: string, roleId: string): Promise<ClubTypeRow> {
    return this.db.withActor(context, async (tx) => {
      const type = await repo.getType(tx, typeId);
      const role = type?.roles.find((r) => r.id === roleId);
      if (!type || !role) throw new DomainError("not_found");
      if (isRequiredRole(role)) throw new DomainError("club_type_role_required");
      await repo.deleteRole(tx, roleId);
      await audit.record(tx, {
        action: "club_type.role.deleted",
        resourceType: "club_type_role",
        resourceId: roleId,
      });
      return (await repo.getType(tx, typeId))!;
    });
  }
}
