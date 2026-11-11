// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AddGroupMemberInput,
  AddGroupMemberSchema,
  type AddGroupOwnerInput,
  AddGroupOwnerSchema,
  type GroupArchivePreview,
  GroupArchivePreviewSchema,
  type GroupArchiveResult,
  GroupArchiveResultSchema,
  type GroupCandidateList,
  GroupCandidateListSchema,
  type GroupCandidatesQuery,
  GroupCandidatesQuerySchema,
  type GroupMemberList,
  GroupMemberListSchema,
  GroupMembershipParamsSchema,
  type GroupMembershipResponse,
  GroupMembershipSchema,
  GroupParamsSchema,
  type PageQuery,
  PageQuerySchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  permits,
  PersonPresenter,
  PersonVisibility,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { GroupsService, toGroupResponse } from "../groups/index.ts";
import { PeopleService } from "../people/index.ts";
import { MembershipsService } from "./memberships.service.ts";

@Controller("groups")
export class GroupMembersController {
  private readonly memberships: MembershipsService;
  private readonly people: PeopleService;
  private readonly visibility: PersonVisibility;
  private readonly presenter: PersonPresenter;
  private readonly groups: GroupsService;

  constructor(
    memberships: MembershipsService,
    people: PeopleService,
    visibility: PersonVisibility,
    presenter: PersonPresenter,
    groups: GroupsService,
  ) {
    this.memberships = memberships;
    this.people = people;
    this.visibility = visibility;
    this.presenter = presenter;
    this.groups = groups;
  }

  /**
   * Three queries: the group's scope (authorization), the page (protected
   * members filtered by the database for non-privileged viewers) and the
   * names; the protected set comes from the cache.
   */
  @Endpoint({
    method: "GET",
    path: ":groupId/members",
    summary: "The group's members by name, with their functions",
    tags: ["groups"],
    access: { permission: "group.members.read", resource: "group" },
    request: { params: GroupParamsSchema, query: PageQuerySchema },
    response: GroupMemberListSchema,
    bulkRead: true,
  })
  async listMembers(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<GroupMemberList> {
    const group = resourceOf(authz, "group");
    const viewerPrivileged = this.visibility.privilegedForGroup(authz.actor, group);
    const context = tenantContext(authz, group.clubId, { viewerPrivileged });
    const page = await this.memberships.groupMembersPage(context, group.groupId, query);
    const rows = await this.people.summaries(
      context,
      page.items.map((m) => m.personId),
    );
    const shown = new Map(
      (await this.presenter.present(authz, group.clubId, rows, { group })).map((p) => [p.id, p]),
    );
    const manages = permits(authz.actor, "group.members.manage", group);
    return {
      items: page.items.flatMap((m) => {
        const person = shown.get(m.personId);
        if (!person) return [];
        return [
          {
            person,
            functions: m.functions,
            ...(manages ? { memberships: m.memberships } : {}),
          },
        ];
      }),
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  }

  // --- Administration (P1.10a) ----------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: ":groupId/candidates",
    summary:
      "Club members to add: active or paused, by name or member number, not in the group with the function",
    tags: ["groups"],
    access: { permission: "group.members.manage", resource: "group" },
    request: { params: GroupParamsSchema, query: GroupCandidatesQuerySchema },
    response: GroupCandidateListSchema,
    bulkRead: true,
  })
  async candidates(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: GroupCandidatesQuery,
  ): Promise<GroupCandidateList> {
    const group = resourceOf(authz, "group");
    // Protected members only for those who see every protected member of the club.
    const viewerPrivileged = authz.actor.holds("club.people.protected", group.clubId);
    const context = tenantContext(authz, group.clubId, { viewerPrivileged });
    const page = await this.memberships.groupCandidates(context, group.groupId, query);
    const rows = await this.people.summaries(
      context,
      page.items.map((c) => c.personId),
    );
    const shown = new Map(
      (await this.presenter.present(authz, group.clubId, rows)).map((p) => [p.id, p]),
    );
    return {
      items: page.items.flatMap((c) => {
        const person = shown.get(c.personId);
        return person ? [{ person, birthYear: c.birthYear, memberNumber: c.memberNumber }] : [];
      }),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: ":groupId/members",
    summary: "Add a club member to the group with a function (a full group needs overCapacity)",
    tags: ["groups"],
    access: { permission: "group.members.manage", resource: "group" },
    request: { params: GroupParamsSchema, body: AddGroupMemberSchema },
    response: GroupMembershipSchema,
    status: 201,
  })
  async addMember(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AddGroupMemberInput,
  ): Promise<GroupMembershipResponse> {
    const group = resourceOf(authz, "group");
    const fn = body.function ?? "member";
    const row = await this.memberships.addGroupMember(
      tenantContext(authz, group.clubId),
      group.groupId,
      body.personId,
      fn,
      {
        overCapacity: body.overCapacity === true,
        ...(body.queueBypassReason ? { queueBypassReason: body.queueBypassReason } : {}),
      },
    );
    return { id: row.id, personId: row.personId, function: row.function };
  }

  @Endpoint({
    method: "DELETE",
    path: ":groupId/memberships/:membershipId",
    summary: "End one function of a member in the group",
    tags: ["groups"],
    access: { permission: "group.members.manage", resource: "group" },
    request: { params: GroupMembershipParamsSchema },
    response: z.null(),
    status: 204,
  })
  async endMembership(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof GroupMembershipParamsSchema>,
  ): Promise<null> {
    const group = resourceOf(authz, "group");
    await this.memberships.endMembershipInGroup(
      tenantContext(authz, group.clubId),
      group.groupId,
      params.membershipId,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: ":groupId/owners",
    summary: "Appoint a group owner: an adult member of the club with a login",
    tags: ["groups"],
    access: { permission: "group.owners.manage", resource: "group" },
    request: { params: GroupParamsSchema, body: AddGroupOwnerSchema },
    response: z.null(),
    status: 204,
  })
  async addOwner(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AddGroupOwnerInput,
  ): Promise<null> {
    const group = resourceOf(authz, "group");
    await this.memberships.addGroupOwner(
      tenantContext(authz, group.clubId),
      group.groupId,
      body.personId,
      authz.actor.holds("group.owners.manage", group.clubId) ? "club_manager" : "group_owner",
    );
    return null;
  }

  @Endpoint({
    method: "GET",
    path: ":groupId/archive-preview",
    summary: "What archiving the group ends and closes",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupArchivePreviewSchema,
  })
  archivePreview(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<GroupArchivePreview> {
    const group = resourceOf(authz, "group");
    return this.memberships.archivePreview(tenantContext(authz, group.clubId), group.groupId);
  }

  @Endpoint({
    method: "POST",
    path: ":groupId/archive",
    summary:
      "Archive a group: its memberships end and its waiting list closes (refused while it has child groups that are not archived)",
    tags: ["groups"],
    access: { permission: "group.update", resource: "group" },
    request: { params: GroupParamsSchema },
    response: GroupArchiveResultSchema,
    status: 200,
  })
  async archiveGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<GroupArchiveResult> {
    const resource = resourceOf(authz, "group");
    const context = tenantContext(authz, resource.clubId);
    const ended = await this.memberships.archiveGroup(context, resource.groupId);
    return { ...toGroupResponse(await this.groups.getGroup(context, resource.groupId)), ended };
  }
}
