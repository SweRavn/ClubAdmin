// SPDX-License-Identifier: AGPL-3.0-only
import {
  ClubParamsSchema,
  type CreateGroupInput,
  CreateGroupSchema,
  type GroupDetail,
  GroupDetailSchema,
  type GroupList,
  GroupListSchema,
  GroupParamsSchema,
  type GroupResponse,
  GroupSchema,
  type PageQuery,
  PageQuerySchema,
  type UpdateGroupInput,
  UpdateGroupSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  AuthorizationService,
  CurrentAuthorization,
  PersonPresenter,
  PersonVisibility,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
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
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly visibility: PersonVisibility;
  private readonly authorization: AuthorizationService;

  constructor(
    groups: GroupsService,
    people: PeopleService,
    presenter: PersonPresenter,
    visibility: PersonVisibility,
    authorization: AuthorizationService,
  ) {
    this.groups = groups;
    this.people = people;
    this.presenter = presenter;
    this.visibility = visibility;
    this.authorization = authorization;
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
    summary: "A group with its owners (people the caller may not see are left out)",
    tags: ["groups"],
    access: { permission: "group.read", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupDetailSchema,
  })
  async getGroup(@CurrentAuthorization() authz: RequestAuthorization): Promise<GroupDetail> {
    const resource = resourceOf(authz, "group");
    const context = tenantContext(authz, resource.clubId, {
      viewerPrivileged: this.visibility.privilegedForGroup(authz.actor, resource),
    });
    const { group, ownerIds } = await this.groups.getGroupWithOwners(context, resource.groupId);
    const owners = await this.presenter.present(
      authz,
      resource.clubId,
      await this.people.summaries(context, ownerIds),
      { group: resource },
    );
    const canManage = authz.actor.isClubManager(resource.clubId) || authz.actor.ownsGroup(resource);
    return {
      ...toGroupResponse(group),
      owners,
      canManage,
      ...(canManage ? { deletable: await this.groups.isDeletable(context, resource.groupId) } : {}),
    };
  }

  // --- Administration (P1.6b) -------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups",
    summary: "Create a group (club managers; owners of a group create child groups of it)",
    tags: ["groups"],
    access: { permission: "club.groups.create", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateGroupSchema },
    response: GroupSchema,
  })
  async createGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateGroupInput,
  ): Promise<GroupResponse> {
    const { clubId } = resourceOf(authz, "club");
    await this.requireParentOwned(authz, clubId, body.parentGroupId ?? null);
    return toGroupResponse(await this.groups.createGroup(tenantContext(authz, clubId), body));
  }

  @Endpoint({
    method: "PATCH",
    path: "groups/:groupId",
    summary: "Change a group: name, kind, details, admission, parent (no cycles)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema, body: UpdateGroupSchema },
    response: GroupSchema,
  })
  async updateGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateGroupInput,
  ): Promise<GroupResponse> {
    const resource = resourceOf(authz, "group");
    if (body.parentGroupId !== undefined) {
      await this.requireParentOwned(authz, resource.clubId, body.parentGroupId);
    }
    return toGroupResponse(
      await this.groups.updateGroup(tenantContext(authz, resource.clubId), resource.groupId, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/archive",
    summary: "Archive a group (refused while it has child groups that are not archived)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupSchema,
    status: 200,
  })
  async archiveGroup(@CurrentAuthorization() authz: RequestAuthorization): Promise<GroupResponse> {
    const resource = resourceOf(authz, "group");
    const context = tenantContext(authz, resource.clubId);
    await this.groups.archiveGroup(context, resource.groupId);
    return toGroupResponse(await this.groups.getGroup(context, resource.groupId));
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/restore",
    summary: "Restore an archived group (club managers)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupSchema,
    status: 200,
  })
  async restoreGroup(@CurrentAuthorization() authz: RequestAuthorization): Promise<GroupResponse> {
    const resource = resourceOf(authz, "group");
    if (!authz.actor.isClubManager(resource.clubId)) throw new DomainError("not_allowed");
    return toGroupResponse(
      await this.groups.restoreGroup(tenantContext(authz, resource.clubId), resource.groupId),
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "groups/:groupId",
    summary: "Delete a group that was never used (otherwise archive it: group_in_use)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteGroup(@CurrentAuthorization() authz: RequestAuthorization): Promise<null> {
    const resource = resourceOf(authz, "group");
    await this.groups.deleteGroup(tenantContext(authz, resource.clubId), resource.groupId);
    return null;
  }

  /**
   * Club managers place groups anywhere in the club; others only under a group
   * they own (or one of its children). Moving to the top level is for club
   * managers.
   */
  private async requireParentOwned(
    authz: RequestAuthorization,
    clubId: string,
    parentGroupId: string | null,
  ): Promise<void> {
    if (authz.actor.isClubManager(clubId)) return;
    if (parentGroupId === null) throw new DomainError("group_not_managed");
    const [parent] = await this.authorization.groupRefs(authz, clubId, [parentGroupId]);
    if (!parent) throw new DomainError("group_parent_invalid");
    if (!authz.actor.ownsGroup(parent)) throw new DomainError("group_not_managed");
  }
}
