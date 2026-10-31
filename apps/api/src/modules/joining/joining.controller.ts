// SPDX-License-Identifier: AGPL-3.0-only
// Finding a club, asking to join it, and the club's view of join requests
// (ADR 0018, P1.1).

import {
  ClubParamsSchema,
  type ClubSearchQuery,
  ClubSearchQuerySchema,
  type ClubSearchResult,
  ClubSearchResultSchema,
  type CreateJoinRequestInput,
  CreateJoinRequestSchema,
  type JoinOutcome,
  JoinOutcomeSchema,
  type JoinRequestDecisionInput,
  JoinRequestDecisionSchema,
  type JoinRequestList,
  JoinRequestListSchema,
  JoinRequestParamsSchema,
  JoinRequestQuerySchema,
  type JoinRequestStatus,
  MyJoinRequestParamsSchema,
  type MyJoinRequests,
  MyJoinRequestsSchema,
  type MyWaitlists,
  MyWaitlistsSchema,
  OkSchema,
  type PersonSummary,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { GroupsService } from "../groups/index.ts";
import { PeopleService } from "../people/index.ts";
import { type JoinRequest, JoinRequestsService } from "./join-requests.service.ts";

const iso = (date: Date | null) => (date ? date.toISOString() : null);

@Controller()
export class JoiningController {
  private readonly joinRequests: JoinRequestsService;
  private readonly people: PeopleService;
  private readonly groups: GroupsService;
  private readonly presenter: PersonPresenter;

  constructor(
    joinRequests: JoinRequestsService,
    people: PeopleService,
    groups: GroupsService,
    presenter: PersonPresenter,
  ) {
    this.joinRequests = joinRequests;
    this.people = people;
    this.groups = groups;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "clubs",
    summary:
      "Search the clubs one can ask to join (not invite-only ones), by name, short name or city",
    tags: ["joining"],
    access: { authenticated: true },
    request: { query: ClubSearchQuerySchema },
    response: ClubSearchResultSchema,
    accountLimit: "joining",
  })
  async search(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ClubSearchQuery,
  ): Promise<ClubSearchResult> {
    return this.joinRequests.search(authz.context, query);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/join-requests",
    summary:
      "Ask to join a club for yourself and/or your children: open clubs take you at once, others decide",
    tags: ["joining"],
    access: { authenticated: true },
    request: { params: ClubParamsSchema, body: CreateJoinRequestSchema },
    response: JoinOutcomeSchema,
    accountLimit: "joining",
  })
  async request(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubId") clubId: string,
    @Body() body: CreateJoinRequestInput,
  ): Promise<JoinOutcome> {
    for (const personId of body.personIds) {
      if (!authz.actor.isSelf(personId) && !authz.actor.isGuardianOf(personId, "act_on_behalf")) {
        throw new DomainError("not_guardian");
      }
    }
    return { items: await this.joinRequests.request(tenantContext(authz, clubId), body) };
  }

  @Endpoint({
    method: "GET",
    path: "me/join-requests",
    summary: "My and my children's join requests: pending ones and the latest decisions",
    tags: ["me", "joining"],
    access: { authenticated: true },
    response: MyJoinRequestsSchema,
  })
  async mine(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyJoinRequests> {
    const self = authz.actor.relationships.personId;
    const ids = [self, ...authz.actor.relationships.wards.map((w) => w.personId)];
    const rows = await this.joinRequests.mine(authz.context, ids);
    const [names, shown] = await Promise.all([
      this.joinRequests.clubNames(
        authz.context,
        rows.map((r) => r.clubId),
      ),
      this.presentIds(
        authz,
        null,
        rows.map((r) => r.personId),
      ),
    ]);
    return {
      items: rows.flatMap((r) => {
        const person = shown.get(r.personId);
        const club = names.get(r.clubId);
        return person ? [{ ...fields(r), club: { id: r.clubId, name: club ?? "" }, person }] : [];
      }),
    };
  }

  @Endpoint({
    method: "GET",
    path: "me/waitlists",
    summary:
      "My and my children's open waiting-list entries (place in the queue) and pending join requests",
    tags: ["me", "joining"],
    access: { authenticated: true },
    response: MyWaitlistsSchema,
  })
  async waitlists(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyWaitlists> {
    const self = authz.actor.relationships.personId;
    const ids = [self, ...authz.actor.relationships.wards.map((w) => w.personId)];
    // One connection per call: the reads run one after the other.
    const entries = await this.groups.myWaitlistEntries(authz.context, ids);
    const requests = (await this.joinRequests.mine(authz.context, ids)).filter(
      (r) => r.status === "pending",
    );
    const names = await this.joinRequests.clubNames(
      authz.context,
      requests.map((r) => r.clubId),
    );
    const shown = await this.presentIds(authz, null, [
      ...entries.map((e) => e.personId),
      ...requests.map((r) => r.personId),
    ]);
    // Preferred groups: the applicant cannot read the club's groups, so their
    // names are read in the club (one transaction per club with a request).
    const groupNames = new Map<string, string>();
    for (const clubId of new Set(requests.map((r) => r.clubId))) {
      const ids = [
        ...new Set(requests.filter((r) => r.clubId === clubId).flatMap((r) => r.preferredGroupIds)),
      ];
      if (ids.length === 0) continue;
      const found = await this.groups.findGroups({ ...authz.context, clubId }, ids);
      for (const g of found) groupNames.set(g.id, g.name);
    }

    return {
      entries: entries.flatMap((e) => {
        const person = shown.get(e.personId);
        if (!person) return [];
        return [
          {
            id: e.id,
            person,
            club: { id: e.clubId, name: e.clubName },
            group: { id: e.groupId, name: e.groupName },
            status: e.status,
            position: e.position,
            waiting: e.waiting,
            queuedAt: e.queuedAt.toISOString(),
            offerExpiresAt: iso(e.offerExpiresAt),
          },
        ];
      }),
      joinRequests: requests.flatMap((r) => {
        const person = shown.get(r.personId);
        if (!person) return [];
        return [
          {
            id: r.id,
            person,
            club: { id: r.clubId, name: names.get(r.clubId) ?? "" },
            preferredGroups: r.preferredGroupIds.flatMap((id) => {
              const name = groupNames.get(id);
              return name ? [{ id, name }] : [];
            }),
            createdAt: r.createdAt.toISOString(),
          },
        ];
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/join-requests/:joinRequestId/withdraw",
    summary: "Withdraw a pending join request",
    tags: ["me", "joining"],
    access: { authenticated: true },
    request: { params: MyJoinRequestParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async withdraw(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("joinRequestId") joinRequestId: string,
  ): Promise<{ ok: true }> {
    await this.joinRequests.withdraw(authz.context, joinRequestId);
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/join-requests",
    summary: "The club's join requests in a status (pending by default), oldest first",
    tags: ["joining"],
    access: { permission: "club.join_requests.manage", resource: "club" },
    request: { params: ClubParamsSchema, query: JoinRequestQuerySchema },
    response: JoinRequestListSchema,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { status: JoinRequestStatus; cursor?: string; limit: number },
  ): Promise<JoinRequestList> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const page = await this.joinRequests.list(context, query.status, query);
    const groupIds = [...new Set(page.items.flatMap((r) => r.preferredGroupIds))];
    const [shown, groups] = await Promise.all([
      this.presentIds(
        authz,
        clubId,
        page.items.flatMap((r) => [r.personId, r.requestedByPersonId]),
      ),
      groupIds.length ? this.groups.findGroups(context, groupIds) : Promise.resolve([]),
    ]);
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));
    return {
      items: page.items.flatMap((r) => {
        const person = shown.get(r.personId);
        if (!person) return [];
        return [
          {
            ...fields(r),
            person,
            requestedBy:
              r.requestedByPersonId === r.personId
                ? null
                : (shown.get(r.requestedByPersonId) ?? null),
            preferredGroups: r.preferredGroupIds.flatMap((id) => {
              const name = groupNames.get(id);
              return name ? [{ id, name }] : [];
            }),
          },
        ];
      }),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/join-requests/:joinRequestId/decision",
    summary: "Approve (the applicant becomes an active member) or reject a join request",
    tags: ["joining"],
    access: { permission: "club.join_requests.manage", resource: "club" },
    request: { params: JoinRequestParamsSchema, body: JoinRequestDecisionSchema },
    response: OkSchema,
    status: 200,
  })
  async decide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("joinRequestId") joinRequestId: string,
    @Body() body: JoinRequestDecisionInput,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.joinRequests.decide(tenantContext(authz, clubId), joinRequestId, body);
    return { ok: true };
  }

  private async presentIds(
    authz: RequestAuthorization,
    clubId: string | null,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    const context = clubId ? tenantContext(authz, clubId) : authz.context;
    const rows = await this.people.summaries(context, unique);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }
}

function fields(r: JoinRequest) {
  return {
    id: r.id,
    status: r.status,
    message: r.message,
    preferredGroupIds: r.preferredGroupIds,
    createdAt: r.createdAt.toISOString(),
    decidedAt: iso(r.decidedAt),
    decisionMessage: r.decisionMessage,
  };
}
