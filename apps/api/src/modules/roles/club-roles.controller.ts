// SPDX-License-Identifier: AGPL-3.0-only
// The roles API (P1.15 A2, ADR 0046): the permission catalogue, a club's
// roles (read by club.roles.read; created, changed, previewed, deleted and
// assigned by club.roles.manage, with a second factor), who holds a
// permission, and the caller's own permissions in a club.

import { catalogues, type Locale, negotiateLocale } from "@clubadmin/i18n";
import {
  type AssignableRoles,
  AssignableRolesSchema,
  type AssignRoleInput,
  AssignRoleSchema,
  ClubParamsSchema,
  type CopyTemplateRoleInput,
  CopyTemplateRoleSchema,
  type CreateRoleInput,
  CreateRoleSchema,
  DeleteRoleQuerySchema,
  DeleteRoleResultSchema,
  GroupParamsSchema,
  type MyPermissions,
  MyPermissionsQuerySchema,
  MyPermissionsSchema,
  OkSchema,
  PageQuerySchema,
  PERMISSION_CATALOGUE,
  type PermissionCatalogueResponse,
  PermissionCatalogueSchema,
  type PermissionHolderPage,
  PermissionHolderPageSchema,
  PermissionParamsSchema,
  type Role,
  RoleAssignmentListSchema,
  RoleAssignmentParamsSchema,
  RoleAssignmentQuerySchema,
  RoleAssignmentSchema,
  type RoleList,
  RoleListSchema,
  RoleParamsSchema,
  type RolePermission,
  type RolePreview,
  type RolePreviewRequest,
  RolePreviewRequestSchema,
  RolePreviewSchema,
  RoleSchema,
  type UpdateRoleInput,
  UpdateRoleSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  type ClubAssignmentRow,
  type ClubRoleRow,
  ClubRolesService,
  lockedPermissionsOf,
  mayAssignGroupRole,
} from "./club-roles.service.ts";

const keyOf = (permission: string) => permission.replaceAll(".", "_");

/** A catalogue text in the caller's language (English when missing). */
function catalogueText(locale: Locale, permission: string, field: string): string | null {
  for (const l of [locale, "en"] as const) {
    const texts = catalogues[l].permissionCatalogue;
    if (typeof texts !== "object") continue;
    const perms = texts.permissions;
    if (typeof perms !== "object") continue;
    const entry = perms[keyOf(permission)];
    if (typeof entry === "object" && typeof entry[field] === "string") return entry[field];
  }
  return null;
}

export function toRoleResponse(role: ClubRoleRow, template?: readonly string[]): Role {
  return {
    id: role.id,
    scope: role.scope,
    templateKey: role.templateKey,
    locked: role.locked,
    lockedPermissions: lockedPermissionsOf(role),
    names: role.names,
    descriptions: role.descriptions,
    permissions: role.permissions,
    holderCount: role.holderCount,
    version: role.version,
    differsFromTemplate:
      template !== undefined &&
      (template.length !== role.permissions.length ||
        template.some((p) => !role.permissions.includes(p))),
  };
}

const toAssignmentResponse = (a: ClubAssignmentRow) => ({
  id: a.id,
  personId: a.personId,
  roleId: a.roleId,
  validFrom: a.validFrom.toISOString(),
  self: a.assignedByPersonId === a.personId,
});

@Controller()
export class ClubRolesController {
  private readonly roles: ClubRolesService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(roles: ClubRolesService, people: PeopleService, presenter: PersonPresenter) {
    this.roles = roles;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "permissions",
    summary: "The permission catalogue, explained in the caller's language",
    tags: ["roles"],
    access: { authenticated: true },
    response: PermissionCatalogueSchema,
  })
  catalogue(@Req() request: FastifyRequest): PermissionCatalogueResponse {
    const locale = negotiateLocale(request.headers["accept-language"]);
    return {
      items: Object.entries(PERMISSION_CATALOGUE).map(([permission, entry]) => ({
        permission,
        kind: entry.kind,
        scope: entry.kind === "role" ? entry.scope : null,
        area: entry.kind === "role" ? entry.area : null,
        sensitive: entry.kind === "role" ? entry.sensitive : false,
        name: entry.kind === "role" ? catalogueText(locale, permission, "name") : null,
        description:
          entry.kind === "role" ? catalogueText(locale, permission, "description") : null,
        example: entry.kind === "role" ? catalogueText(locale, permission, "example") : null,
      })),
    };
  }

  @Endpoint({
    method: "GET",
    path: "me/permissions",
    summary: "What I may do in a club (menus), with the authorization version",
    tags: ["roles"],
    access: { authenticated: true },
    request: { query: MyPermissionsQuerySchema },
    response: MyPermissionsSchema,
  })
  async myPermissions(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof MyPermissionsQuerySchema>,
  ): Promise<MyPermissions> {
    const { actor } = authz;
    if (!actor.hasClubRelationship(query.clubId)) throw new DomainError("not_found");
    const r = actor.relationships;
    const club = r.roles.filter((x) => x.clubId === query.clubId);
    const groups = r.groups.filter((g) => g.clubId === query.clubId);
    const byGroup = new Map<string, Set<string>>();
    for (const g of groups) {
      const set = byGroup.get(g.groupId) ?? new Set<string>();
      for (const p of g.permissions) set.add(p);
      byGroup.set(g.groupId, set);
    }
    const roleIds = [...new Set([...club, ...groups].flatMap((x) => (x.roleId ? [x.roleId] : [])))];
    const roles = await this.roles.rolesByIds(tenantContext(authz, query.clubId), roleIds);
    return {
      clubId: query.clubId,
      permissions: [...new Set(club.flatMap((x) => x.permissions))].sort(),
      groups: [...byGroup].map(([groupId, set]) => ({ groupId, permissions: [...set].sort() })),
      roleIds,
      roles: roles.map((role) => ({
        id: role.id,
        scope: role.scope,
        templateKey: role.templateKey,
        names: role.names,
        permissions: role.permissions,
        groupIds: groups.filter((g) => g.roleId === role.id).map((g) => g.groupId),
      })),
      authzVersion: authz.authzVersion ?? "0",
    };
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/assignable-roles",
    summary: "The group roles I may give in this group (no escalation)",
    tags: ["roles"],
    access: { permission: "group.members.manage", resource: "group" },
    request: { params: GroupParamsSchema },
    response: AssignableRolesSchema,
  })
  async assignable(@CurrentAuthorization() authz: RequestAuthorization): Promise<AssignableRoles> {
    const group = resourceOf(authz, "group");
    const roles = await this.roles.groupRoles(tenantContext(authz, group.clubId));
    return {
      items: roles
        .filter((r) => mayAssignGroupRole(authz.actor, group, r.permissions))
        .map((r) => ({
          id: r.id,
          templateKey: r.templateKey,
          names: r.names,
          permissions: r.permissions,
        })),
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/roles",
    summary: "The club's roles with their permissions and how many hold them",
    tags: ["roles"],
    access: { permission: "club.roles.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: RoleListSchema,
  })
  async list(@CurrentAuthorization() authz: RequestAuthorization): Promise<RoleList> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const { roles, selfAssignments, templates, clubType, templateRoles } =
      await this.roles.listRoles(context);
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          clubId,
          await this.people.summaries(context, [
            ...new Set(selfAssignments.map((a) => a.personId)),
          ]),
        )
      ).map((p) => [p.id, p]),
    );
    return {
      items: roles.map((r) => toRoleResponse(r, templates.get(r.id))),
      selfAssignments: selfAssignments.flatMap((a) => {
        const person = shown.get(a.personId);
        return person
          ? [{ assignmentId: a.id, person, roleId: a.roleId, since: a.validFrom.toISOString() }]
          : [];
      }),
      clubType: clubType ? { id: clubType.id, key: clubType.key, names: clubType.names } : null,
      templateRoles: templateRoles.map((t) => ({
        key: t.key,
        scope: t.scope,
        names: t.names,
        descriptions: t.descriptions,
        permissions: t.permissions,
        status: t.status,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/roles/from-template",
    summary: "Copy a role of the club type's template into the club (a deleted one is restored)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CopyTemplateRoleSchema },
    response: RoleSchema,
    status: 201,
  })
  async fromTemplate(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CopyTemplateRoleInput,
  ): Promise<Role> {
    const { clubId } = resourceOf(authz, "club");
    return toRoleResponse(await this.roles.copyFromTemplate(tenantContext(authz, clubId), body));
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/roles",
    summary: "Create a role (or copy one: send its permissions)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateRoleSchema },
    response: RoleSchema,
    status: 201,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateRoleInput,
  ): Promise<Role> {
    const { clubId } = resourceOf(authz, "club");
    return toRoleResponse(await this.roles.createRole(tenantContext(authz, clubId), body));
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/roles/:roleId",
    summary: "Change a role's names and permissions (locked permissions stay)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: RoleParamsSchema, body: UpdateRoleSchema },
    response: RoleSchema,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("roleId") roleId: string,
    @Body() body: UpdateRoleInput,
  ): Promise<Role> {
    const { clubId } = resourceOf(authz, "club");
    return toRoleResponse(await this.roles.updateRole(tenantContext(authz, clubId), roleId, body));
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/roles/:roleId/preview",
    summary: "What a change of a role's permissions would do (nothing is saved)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: RoleParamsSchema, body: RolePreviewRequestSchema },
    response: RolePreviewSchema,
  })
  async preview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("roleId") roleId: string,
    @Body() body: RolePreviewRequest,
  ): Promise<RolePreview> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const result = await this.roles.previewRole(context, roleId, body.permissions);
    const ids = [...new Set(result.losing.flatMap((l) => l.personIds))];
    const shown = new Map(
      (await this.presenter.present(authz, clubId, await this.people.summaries(context, ids))).map(
        (p) => [p.id, p],
      ),
    );
    return {
      added: result.added,
      removed: result.removed,
      holderCount: result.holderCount,
      losing: result.losing.map((l) => {
        const people = l.personIds.flatMap((id) => {
          const p = shown.get(id);
          return p ? [p] : [];
        });
        return {
          permission: l.permission,
          people,
          hiddenCount: l.personIds.length - people.length,
        };
      }),
    };
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/roles/:roleId",
    summary: "Delete a role: its holders move to a replacement role, or their assignments end",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: RoleParamsSchema, query: DeleteRoleQuerySchema },
    response: DeleteRoleResultSchema,
  })
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("roleId") roleId: string,
    @Query() query: z.infer<typeof DeleteRoleQuerySchema>,
  ): Promise<{ moved: number; ended: number }> {
    const { clubId } = resourceOf(authz, "club");
    return this.roles.deleteRole(tenantContext(authz, clubId), roleId, query.replacementRoleId);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/permissions/:permission/holders",
    summary: "Who holds a permission in the club, and through which roles",
    tags: ["roles"],
    access: { permission: "club.roles.read", resource: "club" },
    request: { params: PermissionParamsSchema, query: PageQuerySchema },
    response: PermissionHolderPageSchema,
  })
  async holders(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("permission") permission: string,
    @Query() query: z.infer<typeof PageQuerySchema>,
  ): Promise<PermissionHolderPage> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const rows = await this.roles.holdersOfPermission(context, permission as RolePermission, {
      cursor: query.cursor ?? null,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          clubId,
          await this.people.summaries(
            context,
            page.map((r) => r.personId),
          ),
        )
      ).map((p) => [p.id, p]),
    );
    return {
      items: page.flatMap((r) => {
        const person = shown.get(r.personId);
        return person ? [{ person, roleIds: r.roleIds, groupIds: r.groupIds }] : [];
      }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.personId ?? null) : null,
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/role-assignments",
    summary: "A person's club roles",
    tags: ["roles"],
    access: { permission: "club.roles.read", resource: "club" },
    request: { params: ClubParamsSchema, query: RoleAssignmentQuerySchema },
    response: RoleAssignmentListSchema,
  })
  async assignments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof RoleAssignmentQuerySchema>,
  ): Promise<z.infer<typeof RoleAssignmentListSchema>> {
    const { clubId } = resourceOf(authz, "club");
    const rows = await this.roles.assignmentsOfPerson(tenantContext(authz, clubId), query.personId);
    return { items: rows.map(toAssignmentResponse) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/role-assignments",
    summary: "Give a person a club role (any role; giving it to yourself is told to the others)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: AssignRoleSchema },
    response: RoleAssignmentSchema,
    status: 201,
  })
  async assign(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AssignRoleInput,
  ): Promise<z.infer<typeof RoleAssignmentSchema>> {
    const { clubId } = resourceOf(authz, "club");
    if (authz.actor.onBehalfOf !== null) throw new DomainError("not_allowed");
    return toAssignmentResponse(
      await this.roles.assignClubRole(tenantContext(authz, clubId), body.personId, body.roleId),
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/role-assignments/:assignmentId",
    summary: "End a club role assignment (never the last club manager)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: RoleAssignmentParamsSchema },
    response: OkSchema,
  })
  async unassign(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("assignmentId") assignmentId: string,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.roles.unassign(tenantContext(authz, clubId), assignmentId);
    return { ok: true };
  }
}
