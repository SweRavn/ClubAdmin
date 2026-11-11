// SPDX-License-Identifier: AGPL-3.0-only
import {
  ClubParamsSchema,
  type CreateGroupInput,
  CreateGroupSchema,
  type CreateSeasonInput,
  CreateSeasonSchema,
  type GroupDetail,
  GroupDetailSchema,
  type GroupList,
  GroupListSchema,
  GroupOwnerParamsSchema,
  GroupParamsSchema,
  type GroupResponse,
  GroupSchema,
  type GroupSeasonList,
  GroupSeasonListSchema,
  GroupSeasonParamsSchema,
  type GroupSeasonResponse,
  GroupSeasonSchema,
  type PageQuery,
  PageQuerySchema,
  type PutGroupSeasonInput,
  PutGroupSeasonSchema,
  type SeasonList,
  SeasonListSchema,
  type SeasonResponse,
  SeasonSchema,
  type UpdateGroupInput,
  UpdateGroupSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  AuthorizationService,
  CurrentAuthorization,
  permits,
  PersonPresenter,
  PersonVisibility,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { type Group, GroupsService, type Season } from "./groups.service.ts";

function toSeasonResponse(season: Season): SeasonResponse {
  return {
    id: season.id,
    name: season.name,
    startsOn: season.startsOn,
    endsOn: season.endsOn,
  };
}

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
      includeArchived: authz.actor.holds("club.groups.archived.read", clubId),
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
    const canManage =
      authz.actor.holds("group.update", resource) || authz.actor.ownsGroup(resource);
    const { group, ownerIds, capacity, deletable, waitingCount } =
      await this.groups.getGroupWithOwners(context, resource.groupId, { manage: canManage });
    const owners = await this.presenter.present(
      authz,
      resource.clubId,
      await this.people.summaries(context, ownerIds),
      { group: resource },
    );
    return {
      ...toGroupResponse(group),
      owners,
      canManage,
      canManageMembers: permits(authz.actor, "group.members.manage", resource),
      canManageOwners: permits(authz.actor, "group.owners.manage", resource),
      canManageWaitlist: permits(authz.actor, "group.waitlist.manage", resource),
      waitingCount,
      ...(canManage && capacity
        ? {
            deletable,
            effectiveCapacity: capacity.capacity,
            occupied: capacity.occupied,
            waitlistVisiblePublicly: group.waitlistVisiblePublicly,
            offerReplyDays: group.offerReplyDays,
            waitlistAutoOffer: group.waitlistAutoOffer,
          }
        : {}),
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
    // Restoring: club-wide holders of group.update only (club managers), not owners.
    if (!authz.actor.holds("group.update", resource.clubId)) throw new DomainError("not_allowed");
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

  // --- Owners and seasons (P1.10a) -----------------------------------------------------

  @Endpoint({
    method: "DELETE",
    path: "groups/:groupId/owners/:personId",
    summary: "End a group ownership (club managers; owners where the club allows co-owners)",
    tags: ["groups"],
    access: { permission: "group.owners.manage", resource: "group" },
    request: { params: GroupOwnerParamsSchema },
    response: z.null(),
    status: 204,
  })
  async removeOwner(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof GroupOwnerParamsSchema>,
  ): Promise<null> {
    const resource = resourceOf(authz, "group");
    await this.groups.removeOwner(
      tenantContext(authz, resource.clubId),
      resource.groupId,
      params.personId,
      authz.actor.holds("group.owners.manage", resource.clubId) ? "club_manager" : "group_owner",
    );
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/seasons",
    summary: "The club's seasons, newest first",
    tags: ["groups"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: SeasonListSchema,
  })
  async listSeasons(@CurrentAuthorization() authz: RequestAuthorization): Promise<SeasonList> {
    const { clubId } = resourceOf(authz, "club");
    const items = await this.groups.listSeasons(tenantContext(authz, clubId));
    return { items: items.map(toSeasonResponse) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/seasons",
    summary: "Add a season (club managers, with a second factor)",
    tags: ["groups"],
    access: { permission: "club.settings.update", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateSeasonSchema },
    response: SeasonSchema,
    status: 201,
  })
  async createSeason(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateSeasonInput,
  ): Promise<SeasonResponse> {
    const { clubId } = resourceOf(authz, "club");
    return toSeasonResponse(await this.groups.createSeason(tenantContext(authz, clubId), body));
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/seasons",
    summary: "The group's places and notes per season (those who edit the group)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupSeasonListSchema,
  })
  async groupSeasons(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<GroupSeasonList> {
    const resource = resourceOf(authz, "group");
    return {
      items: await this.groups.groupSeasons(
        tenantContext(authz, resource.clubId),
        resource.groupId,
      ),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "groups/:groupId/seasons/:seasonId",
    summary: "Set the group's places and notes for a season (idempotent)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupSeasonParamsSchema, body: PutGroupSeasonSchema },
    response: GroupSeasonSchema,
  })
  async putGroupSeason(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof GroupSeasonParamsSchema>,
    @Body() body: PutGroupSeasonInput,
  ): Promise<GroupSeasonResponse> {
    const resource = resourceOf(authz, "group");
    const settings = { capacity: body.capacity, notes: body.notes ?? null };
    await this.groups.setGroupSeason(
      tenantContext(authz, resource.clubId),
      resource.groupId,
      params.seasonId,
      settings,
    );
    return { seasonId: params.seasonId, ...settings };
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
    if (authz.actor.holds("club.groups.create", clubId)) return;
    if (parentGroupId === null) throw new DomainError("group_not_managed");
    const [parent] = await this.authorization.groupRefs(authz, clubId, [parentGroupId]);
    if (!parent) throw new DomainError("group_parent_invalid");
    if (!authz.actor.ownsGroup(parent)) throw new DomainError("group_not_managed");
  }
}
