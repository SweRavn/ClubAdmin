// SPDX-License-Identifier: AGPL-3.0-only
import {
  ClubParamsSchema,
  type GroupList,
  GroupListSchema,
  GroupParamsSchema,
  type GroupResponse,
  GroupSchema,
  type PageQuery,
  PageQuerySchema,
} from "@clubadmin/shared";
import { Controller, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { type Group, GroupsService } from "./groups.service.ts";

export function toGroupResponse(group: Group): GroupResponse {
  return {
    id: group.id,
    clubId: group.clubId,
    parentGroupId: group.parentGroupId,
    kind: group.kind,
    name: group.name,
    sport: group.sport,
    birthYearFrom: group.birthYearFrom,
    birthYearTo: group.birthYearTo,
    genderCategory: group.genderCategory,
    level: group.level,
    capacity: group.capacity,
    admissionMode: group.admissionMode,
    archived: group.archivedAt !== null,
  };
}

@Controller()
export class GroupsController {
  private readonly groups: GroupsService;

  constructor(groups: GroupsService) {
    this.groups = groups;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups",
    summary: "The club's groups by name (archived ones for managers and registrars)",
    tags: ["groups"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: GroupListSchema,
  })
  async listGroups(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<GroupList> {
    const { clubId } = resourceOf(authz, "club");
    const page = await this.groups.listGroups(tenantContext(authz, clubId), {
      cursor: query.cursor,
      limit: query.limit,
      includeArchived: authz.actor.hasClubRole(clubId, "club_manager", "registrar"),
    });
    return { items: page.items.map(toGroupResponse), nextCursor: page.nextCursor };
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId",
    summary: "A group",
    tags: ["groups"],
    access: { permission: "group.read", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupSchema,
  })
  async getGroup(@CurrentAuthorization() authz: RequestAuthorization): Promise<GroupResponse> {
    const group = resourceOf(authz, "group");
    return toGroupResponse(
      await this.groups.getGroup(tenantContext(authz, group.clubId), group.groupId),
    );
  }
}
