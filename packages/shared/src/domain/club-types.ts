// SPDX-License-Identifier: AGPL-3.0-only
// Club types and their templates (P1.15 B, ADR 0046): a type has a template
// of roles with permissions; a new club gets a copy. Operators edit types;
// every type keeps the roles the code relies on (REQUIRED_TEMPLATE_ROLES).

import {
  LOCKED_ROLES,
  PERMISSION_CATALOGUE,
  type RolePermission,
} from "../authorization/permission-catalogue.ts";
import { z } from "../zod.ts";
import { CLUB_ROLES, GROUP_FUNCTIONS } from "./core.ts";
import { RolePermissionSchema, RoleScopeSchema } from "./roles.ts";

/** The built-in type (today's template, migration 0036): the default for a club without one. */
export const BUILT_IN_CLUB_TYPE = "sports_club";

/** A type's or a template role's key. */
export const CLUB_TYPE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const key = z.string().regex(CLUB_TYPE_KEY);

/**
 * Roles every type has, with the permissions they must hold: the locked
 * roles (the club manager administers access, the chair recovers a club)
 * and the participant group role, which adding by function, imports,
 * waiting lists, join requests and invitations ask for by its key.
 */
export const REQUIRED_TEMPLATE_ROLES: readonly {
  scope: "club" | "group";
  key: string;
  permissions: readonly RolePermission[];
  locked: boolean;
}[] = [
  { scope: "club", key: "club_manager", permissions: LOCKED_ROLES.club_manager, locked: true },
  { scope: "club", key: "chair", permissions: LOCKED_ROLES.chair, locked: true },
  { scope: "group", key: "member", permissions: ["group.participate"], locked: false },
];

/** Keys with a name in the message catalogue (`roles.*`, `functions.*`). */
export function hasCatalogueName(scope: "club" | "group", roleKey: string): boolean {
  return scope === "club"
    ? (CLUB_ROLES as readonly string[]).includes(roleKey)
    : (GROUP_FUNCTIONS as readonly string[]).includes(roleKey);
}

/** Why a template role's permissions are not allowed (wrong scope, unknown), or null. */
export function templatePermissionProblem(
  scope: "club" | "group",
  permissions: readonly string[],
): "invalid_input" | "permission_not_for_group_roles" | null {
  for (const p of permissions) {
    const entry = PERMISSION_CATALOGUE[p as RolePermission];
    if (entry?.kind !== "role") return "invalid_input";
    if (scope === "group" && entry.scope === "club") return "permission_not_for_group_roles";
  }
  return null;
}

/** Names in all three languages (sv, en, nb). */
export const ClubTypeNamesSchema = z
  .object({
    sv: z.string().trim().min(1).max(60),
    en: z.string().trim().min(1).max(60),
    nb: z.string().trim().min(1).max(60),
  })
  .openapi("ClubTypeNames");
export type ClubTypeNames = z.infer<typeof ClubTypeNamesSchema>;

export const ClubTypeDescriptionsSchema = z
  .object({
    sv: z.string().trim().max(300).optional(),
    en: z.string().trim().max(300).optional(),
    nb: z.string().trim().max(300).optional(),
  })
  .openapi("ClubTypeDescriptions");

export const ClubTypeRoleSchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    scope: RoleScopeSchema,
    /** Null: the catalogue's name for the key (known keys only). */
    names: ClubTypeNamesSchema.nullable(),
    descriptions: ClubTypeDescriptionsSchema.nullable(),
    locked: z.boolean(),
    /** One of the roles every type must have (cannot be removed). */
    required: z.boolean(),
    sortOrder: z.number().int(),
    permissions: z.array(z.string()),
  })
  .openapi("ClubTypeRole");
export type ClubTypeRole = z.infer<typeof ClubTypeRoleSchema>;

export const ClubTypeSchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    names: ClubTypeNamesSchema,
    descriptions: ClubTypeDescriptionsSchema.nullable(),
    active: z.boolean(),
    /** The built-in type: the default, cannot be deactivated. */
    builtIn: z.boolean(),
    sortOrder: z.number().int(),
    roles: z.array(ClubTypeRoleSchema),
  })
  .openapi("ClubType");
export type ClubType = z.infer<typeof ClubTypeSchema>;

export const ClubTypeListSchema = z
  .object({ items: z.array(ClubTypeSchema) })
  .openapi("ClubTypeList");
export type ClubTypeList = z.infer<typeof ClubTypeListSchema>;

export const ClubTypeParamsSchema = z.object({ clubTypeId: z.uuid() });
export const ClubTypeRoleParamsSchema = z.object({ clubTypeId: z.uuid(), roleId: z.uuid() });

/** A new type starts with the required roles (copied from the built-in type). */
export const CreateClubTypeSchema = z
  .object({
    key,
    names: ClubTypeNamesSchema,
    descriptions: ClubTypeDescriptionsSchema.optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .openapi("CreateClubType");
export type CreateClubTypeInput = z.infer<typeof CreateClubTypeSchema>;

export const UpdateClubTypeSchema = z
  .object({
    names: ClubTypeNamesSchema.optional(),
    descriptions: ClubTypeDescriptionsSchema.nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .openapi("UpdateClubType");
export type UpdateClubTypeInput = z.infer<typeof UpdateClubTypeSchema>;

export const CreateClubTypeRoleSchema = z
  .object({
    key,
    scope: RoleScopeSchema,
    /** Required for a key without a catalogue name. */
    names: ClubTypeNamesSchema.optional(),
    descriptions: ClubTypeDescriptionsSchema.optional(),
    permissions: z.array(RolePermissionSchema).max(100),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .openapi("CreateClubTypeRole");
export type CreateClubTypeRoleInput = z.infer<typeof CreateClubTypeRoleSchema>;

export const UpdateClubTypeRoleSchema = z
  .object({
    /** Null: the catalogue's name (known keys only). */
    names: ClubTypeNamesSchema.nullable().optional(),
    descriptions: ClubTypeDescriptionsSchema.nullable().optional(),
    permissions: z.array(RolePermissionSchema).max(100).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .openapi("UpdateClubTypeRole");
export type UpdateClubTypeRoleInput = z.infer<typeof UpdateClubTypeRoleSchema>;
