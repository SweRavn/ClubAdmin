// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles (P1.15 A2, ADR 0046): the roles API's schemas. A role is
// a named set of permissions from the catalogue (permission-catalogue.ts),
// held in the club or in a group. Names are per language; null names of a
// template role mean the catalogue's text (decision 9).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { ROLE_PERMISSIONS } from "../authorization/permission-catalogue.ts";
import { z } from "../zod.ts";

export const ROLE_SCOPES = ["club", "group"] as const;
export const RoleScopeSchema = z.enum(ROLE_SCOPES);

/** A permission a role can hold (catalogue key). */
export const RolePermissionSchema = z
  .string()
  .refine((p) => (ROLE_PERMISSIONS as readonly string[]).includes(p), "unknown permission")
  .openapi("RolePermission", { description: "A key of the permission catalogue" });

/** A text per language (sv, en, nb); at least one language. */
export const RoleTextsSchema = z
  .object({
    sv: z.string().trim().min(1).max(60).optional(),
    en: z.string().trim().min(1).max(60).optional(),
    nb: z.string().trim().min(1).max(60).optional(),
  })
  .openapi("RoleTexts");
export type RoleTexts = z.infer<typeof RoleTextsSchema>;

const RoleDescriptionsSchema = z
  .object({
    sv: z.string().trim().max(300).optional(),
    en: z.string().trim().max(300).optional(),
    nb: z.string().trim().max(300).optional(),
  })
  .openapi("RoleDescriptions");

export const RoleSchema = z
  .object({
    id: z.uuid(),
    scope: RoleScopeSchema,
    /** The template role it comes from (`registrar`, `head_coach`, ...); null for the club's own. */
    templateKey: z.string().nullable(),
    /** The club manager and the chair: cannot be deleted, keep their locked permissions. */
    locked: z.boolean(),
    /** Permissions that cannot be removed from this role. */
    lockedPermissions: z.array(z.string()),
    /** Null: the catalogue's name for the template key. */
    names: RoleTextsSchema.nullable(),
    descriptions: RoleDescriptionsSchema.nullable(),
    permissions: z.array(z.string()),
    /** Open assignments (people may be counted once per group they hold it in). */
    holderCount: z.number().int(),
    /** Optimistic concurrency: send it back when changing the role. */
    version: z.number().int(),
    /** The template's permissions differ from the role's (a template role was changed). */
    differsFromTemplate: z.boolean(),
  })
  .openapi("Role");
export type Role = z.infer<typeof RoleSchema>;

export const SelfAssignmentSchema = z
  .object({
    assignmentId: z.uuid(),
    person: PersonSummarySchema,
    roleId: z.uuid(),
    since: z.iso.datetime(),
  })
  .openapi("SelfAssignment");

/**
 * A role of the club type's template (P1.15 B), and whether the club has it:
 * `present`, `archived` (deleted; copying restores it) or `missing`.
 */
export const TemplateRoleSchema = z
  .object({
    key: z.string(),
    scope: RoleScopeSchema,
    names: RoleTextsSchema.nullable(),
    descriptions: RoleDescriptionsSchema.nullable(),
    permissions: z.array(z.string()),
    status: z.enum(["present", "archived", "missing"]),
  })
  .openapi("TemplateRole");
export type TemplateRole = z.infer<typeof TemplateRoleSchema>;

export const RoleListSchema = z
  .object({
    items: z.array(RoleSchema),
    /** Roles that administrators gave themselves and still hold (shown on the roles page). */
    selfAssignments: z.array(SelfAssignmentSchema),
    /** The club's type (P1.15 B). */
    clubType: z
      .object({ id: z.uuid(), key: z.string(), names: RoleTextsSchema })
      .nullable()
      .default(null),
    /** The type's template roles, to compare and copy ("Lägg till från mallen"). */
    templateRoles: z.array(TemplateRoleSchema).default([]),
  })
  .openapi("RoleList");
export type RoleList = z.infer<typeof RoleListSchema>;

export const RoleParamsSchema = z.object({ clubId: z.uuid(), roleId: z.uuid() });

export const CreateRoleSchema = z
  .object({
    scope: RoleScopeSchema,
    names: RoleTextsSchema.refine((n) => Boolean(n.sv ?? n.en ?? n.nb), "a name"),
    descriptions: RoleDescriptionsSchema.optional(),
    permissions: z.array(RolePermissionSchema).max(100),
  })
  .openapi("CreateRole");
export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

export const UpdateRoleSchema = z
  .object({
    /** The version the change was made from (a newer one: 409 role_changed). */
    version: z.number().int(),
    /** Null: back to the catalogue's name (template roles). */
    names: RoleTextsSchema.nullable().optional(),
    descriptions: RoleDescriptionsSchema.nullable().optional(),
    permissions: z.array(RolePermissionSchema).max(100).optional(),
    /** Back to the template's permissions and names (template roles). */
    resetToTemplate: z.boolean().optional(),
  })
  .openapi("UpdateRole");
export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;

/** Copy a role of the club type's template into the club (P1.15 B). */
export const CopyTemplateRoleSchema = z
  .object({ scope: RoleScopeSchema, key: z.string().min(1).max(40) })
  .strict()
  .openapi("CopyTemplateRole");
export type CopyTemplateRoleInput = z.infer<typeof CopyTemplateRoleSchema>;

export const RolePreviewRequestSchema = z
  .object({ permissions: z.array(RolePermissionSchema).max(100) })
  .openapi("RolePreviewRequest");
export type RolePreviewRequest = z.infer<typeof RolePreviewRequestSchema>;

export const RolePreviewSchema = z
  .object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    /** Holders of the role (everyone the change concerns). */
    holderCount: z.number().int(),
    /**
     * Per removed permission: holders who no longer hold it through any role.
     * People the caller may not see are counted, not named.
     */
    losing: z.array(
      z.object({
        permission: z.string(),
        people: z.array(PersonSummarySchema),
        hiddenCount: z.number().int(),
      }),
    ),
  })
  .openapi("RolePreview");
export type RolePreview = z.infer<typeof RolePreviewSchema>;

export const DeleteRoleQuerySchema = z.object({
  /** Holders move to this role (same scope); without it their assignments end. */
  replacementRoleId: z.uuid().optional(),
});

export const DeleteRoleResultSchema = z
  .object({ moved: z.number().int(), ended: z.number().int() })
  .openapi("DeleteRoleResult");

export const PermissionParamsSchema = z.object({
  clubId: z.uuid(),
  permission: RolePermissionSchema,
});

export const PermissionHolderSchema = z
  .object({
    person: PersonSummarySchema,
    /** The roles through which they hold it. */
    roleIds: z.array(z.uuid()),
    /** Held in these groups only (group roles); empty for the whole club. */
    groupIds: z.array(z.uuid()),
  })
  .openapi("PermissionHolder");

export const PermissionHolderPageSchema = z
  .object({ items: z.array(PermissionHolderSchema), nextCursor: z.uuid().nullable() })
  .openapi("PermissionHolderPage");
export type PermissionHolderPage = z.infer<typeof PermissionHolderPageSchema>;

export const CatalogueEntrySchema = z
  .object({
    permission: z.string(),
    kind: z.enum(["role", "derived", "built_in"]),
    scope: z.enum(["club", "group"]).nullable(),
    area: z.string().nullable(),
    sensitive: z.boolean(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    example: z.string().nullable(),
  })
  .openapi("PermissionCatalogueEntry");

export const PermissionCatalogueSchema = z
  .object({ items: z.array(CatalogueEntrySchema) })
  .openapi("PermissionCatalogue");
export type PermissionCatalogueResponse = z.infer<typeof PermissionCatalogueSchema>;

export const MyPermissionsQuerySchema = z.object({ clubId: z.uuid() });

export const MyPermissionsSchema = z
  .object({
    clubId: z.uuid(),
    /** Held through club roles (in the whole club). */
    permissions: z.array(z.string()),
    /** Held through group roles, per group. */
    groups: z.array(z.object({ groupId: z.uuid(), permissions: z.array(z.string()) })),
    /** The caller's roles in the club (club and group roles). */
    roleIds: z.array(z.uuid()),
    /** The same roles with their names and permissions ("my roles"). */
    roles: z.array(
      z.object({
        id: z.uuid(),
        scope: RoleScopeSchema,
        templateKey: z.string().nullable(),
        names: RoleTextsSchema.nullable(),
        permissions: z.array(z.string()),
        /** Group roles: the groups they are held in. */
        groupIds: z.array(z.uuid()),
      }),
    ),
    /** Compare with the x-authz-version header to know when to refresh. */
    authzVersion: z.string(),
  })
  .openapi("MyPermissions");
export type MyPermissions = z.infer<typeof MyPermissionsSchema>;

/** Group roles the caller may give in a group (no escalation, P1.15 A2). */
export const AssignableRolesSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        templateKey: z.string().nullable(),
        names: RoleTextsSchema.nullable(),
        permissions: z.array(z.string()),
      }),
    ),
  })
  .openapi("AssignableRoles");
export type AssignableRoles = z.infer<typeof AssignableRolesSchema>;

export const AssignRoleSchema = z
  .object({ personId: z.uuid(), roleId: z.uuid() })
  .openapi("AssignRole");
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

export const RoleAssignmentParamsSchema = z.object({ clubId: z.uuid(), assignmentId: z.uuid() });

export const RoleAssignmentSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    roleId: z.uuid(),
    validFrom: z.iso.datetime(),
    /** Assigned by the person to themselves (shown and told, P1.15). */
    self: z.boolean(),
  })
  .openapi("ClubRoleAssignment");

export const RoleAssignmentListSchema = z
  .object({ items: z.array(RoleAssignmentSchema) })
  .openapi("ClubRoleAssignmentList");

export const RoleAssignmentQuerySchema = z.object({ personId: z.uuid() });
