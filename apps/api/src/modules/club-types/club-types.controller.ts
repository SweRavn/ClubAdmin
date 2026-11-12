// SPDX-License-Identifier: AGPL-3.0-only
// Club types (P1.15 B, ADR 0046): everyone logged in lists the active types
// to choose one when creating a club; operators (with a second factor) list,
// create and edit types and their template roles. No personal data.

import {
  BUILT_IN_CLUB_TYPE,
  type ClubType,
  type ClubTypeList,
  ClubTypeListSchema,
  ClubTypeParamsSchema,
  ClubTypeRoleParamsSchema,
  ClubTypeSchema,
  type CreateClubTypeInput,
  type CreateClubTypeRoleInput,
  CreateClubTypeRoleSchema,
  CreateClubTypeSchema,
  type UpdateClubTypeInput,
  type UpdateClubTypeRoleInput,
  UpdateClubTypeRoleSchema,
  UpdateClubTypeSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { CurrentAuthorization, type RequestAuthorization } from "../authorization/index.ts";
import { type ClubTypeRow, ClubTypesService, isRequiredRole } from "./club-types.service.ts";

export function toClubType(type: ClubTypeRow): ClubType {
  return {
    id: type.id,
    key: type.key,
    names: type.names as ClubType["names"],
    descriptions: type.descriptions,
    active: type.active,
    builtIn: type.key === BUILT_IN_CLUB_TYPE,
    sortOrder: type.sortOrder,
    roles: type.roles.map((r) => ({
      id: r.id,
      key: r.key,
      scope: r.scope,
      names: r.names as ClubType["names"] | null,
      descriptions: r.descriptions,
      locked: r.locked,
      required: isRequiredRole(r),
      sortOrder: r.sortOrder,
      permissions: r.permissions,
    })),
  };
}

@Controller()
export class ClubTypesController {
  private readonly types: ClubTypesService;

  constructor(types: ClubTypesService) {
    this.types = types;
  }

  private operator(authz: RequestAuthorization) {
    return { ...authz.context, actorKind: "operator" as const };
  }

  @Endpoint({
    method: "GET",
    path: "club-types",
    summary: "The active club types with their roles (choosing one when creating a club)",
    tags: ["onboarding"],
    access: { authenticated: true },
    response: ClubTypeListSchema,
  })
  async active(@CurrentAuthorization() authz: RequestAuthorization): Promise<ClubTypeList> {
    return { items: (await this.types.activeTypes(authz.context)).map(toClubType) };
  }

  @Endpoint({
    method: "GET",
    path: "ops/club-types",
    summary: "Every club type with its template (operators)",
    tags: ["ops"],
    access: { permission: "club_types.read", resource: "platform" },
    response: ClubTypeListSchema,
  })
  async all(@CurrentAuthorization() authz: RequestAuthorization): Promise<ClubTypeList> {
    return { items: (await this.types.allTypes(this.operator(authz))).map(toClubType) };
  }

  @Endpoint({
    method: "GET",
    path: "ops/club-types/:clubTypeId",
    summary: "A club type with its template (operators)",
    tags: ["ops"],
    access: { permission: "club_types.read", resource: "platform" },
    request: { params: ClubTypeParamsSchema },
    response: ClubTypeSchema,
  })
  async one(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubTypeId") clubTypeId: string,
  ): Promise<ClubType> {
    return toClubType(await this.types.getType(this.operator(authz), clubTypeId));
  }

  @Endpoint({
    method: "POST",
    path: "ops/club-types",
    summary: "Create a club type; it starts with the roles every type needs (operators)",
    tags: ["ops"],
    access: { permission: "club_types.manage", resource: "platform" },
    request: { body: CreateClubTypeSchema },
    response: ClubTypeSchema,
    status: 201,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateClubTypeInput,
  ): Promise<ClubType> {
    return toClubType(await this.types.createType(this.operator(authz), body));
  }

  @Endpoint({
    method: "PATCH",
    path: "ops/club-types/:clubTypeId",
    summary: "Rename, describe, (de)activate or reorder a club type (operators)",
    tags: ["ops"],
    access: { permission: "club_types.manage", resource: "platform" },
    request: { params: ClubTypeParamsSchema, body: UpdateClubTypeSchema },
    response: ClubTypeSchema,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubTypeId") clubTypeId: string,
    @Body() body: UpdateClubTypeInput,
  ): Promise<ClubType> {
    return toClubType(await this.types.updateType(this.operator(authz), clubTypeId, body));
  }

  @Endpoint({
    method: "POST",
    path: "ops/club-types/:clubTypeId/roles",
    summary: "Add a role to a club type's template (operators)",
    tags: ["ops"],
    access: { permission: "club_types.manage", resource: "platform" },
    request: { params: ClubTypeParamsSchema, body: CreateClubTypeRoleSchema },
    response: ClubTypeSchema,
    status: 201,
  })
  async createRole(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubTypeId") clubTypeId: string,
    @Body() body: CreateClubTypeRoleInput,
  ): Promise<ClubType> {
    return toClubType(await this.types.createRole(this.operator(authz), clubTypeId, body));
  }

  @Endpoint({
    method: "PATCH",
    path: "ops/club-types/:clubTypeId/roles/:roleId",
    summary: "Rename a template role or change its permissions (operators)",
    tags: ["ops"],
    access: { permission: "club_types.manage", resource: "platform" },
    request: { params: ClubTypeRoleParamsSchema, body: UpdateClubTypeRoleSchema },
    response: ClubTypeSchema,
  })
  async updateRole(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubTypeId") clubTypeId: string,
    @Param("roleId") roleId: string,
    @Body() body: UpdateClubTypeRoleInput,
  ): Promise<ClubType> {
    return toClubType(await this.types.updateRole(this.operator(authz), clubTypeId, roleId, body));
  }

  @Endpoint({
    method: "DELETE",
    path: "ops/club-types/:clubTypeId/roles/:roleId",
    summary: "Remove a role from a club type's template; clubs keep theirs (operators)",
    tags: ["ops"],
    access: { permission: "club_types.manage", resource: "platform" },
    request: { params: ClubTypeRoleParamsSchema },
    response: ClubTypeSchema,
    status: 200,
  })
  async deleteRole(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubTypeId") clubTypeId: string,
    @Param("roleId") roleId: string,
  ): Promise<ClubType> {
    return toClubType(await this.types.deleteRole(this.operator(authz), clubTypeId, roleId));
  }
}
