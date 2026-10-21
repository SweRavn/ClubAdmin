// SPDX-License-Identifier: AGPL-3.0-only
import {
  type GroupMemberList,
  GroupMemberListSchema,
  GroupParamsSchema,
  type PageQuery,
  PageQuerySchema,
} from "@clubadmin/shared";
import { Controller, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  PersonVisibility,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { MembershipsService } from "./memberships.service.ts";

@Controller("groups")
export class GroupMembersController {
  private readonly memberships: MembershipsService;
  private readonly people: PeopleService;
  private readonly visibility: PersonVisibility;
  private readonly presenter: PersonPresenter;

  constructor(
    memberships: MembershipsService,
    people: PeopleService,
    visibility: PersonVisibility,
    presenter: PersonPresenter,
  ) {
    this.memberships = memberships;
    this.people = people;
    this.visibility = visibility;
    this.presenter = presenter;
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
    return {
      items: page.items.flatMap((m) => {
        const person = shown.get(m.personId);
        return person ? [{ person, functions: m.functions }] : [];
      }),
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  }
}
