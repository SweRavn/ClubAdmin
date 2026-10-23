// SPDX-License-Identifier: AGPL-3.0-only
// The member register (P1.2): search, filters and facet counts, and changes
// of a membership. Club managers and registrars see the full register with
// protected members marked; board roles a limited list without them.

import {
  type AddMemberInput,
  type AddMemberResult,
  AddMemberResultSchema,
  AddMemberSchema,
  ClubParamsSchema,
  LIMITED_REGISTER_FILTERS,
  MemberParamsSchema,
  type MembershipResult,
  MembershipResultSchema,
  type RegisterAccess,
  type RegisterFacets,
  RegisterFacetsSchema,
  type RegisterFilter,
  type RegisterPage,
  RegisterPageSchema,
  type RegisterQuery,
  RegisterQuerySchema,
  type UpdateMembershipInput,
  UpdateMembershipSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  registerAccess,
  type RegisterPerson,
  RegisterPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { MembershipsService } from "../memberships/index.ts";
import { PeopleService } from "../people/index.ts";
import { MemberIntakeService } from "./member-intake.service.ts";
import { MembersService } from "./members.service.ts";

const FILTER_KEYS = [
  "q",
  "status",
  "type",
  "groupId",
  "role",
  "bornFrom",
  "bornTo",
  "gender",
  "missingConsent",
] as const satisfies readonly (keyof RegisterFilter)[];

/** The filter part of the query; the limited register only searches by name, type and group. */
export function registerFilterOf(query: RegisterQuery, access: RegisterAccess): RegisterFilter {
  const filter: RegisterFilter = {};
  for (const key of FILTER_KEYS) {
    if (query[key] === undefined) continue;
    if (access === "limited" && !(LIMITED_REGISTER_FILTERS as readonly string[]).includes(key)) {
      throw new DomainError("register_filter_not_allowed");
    }
    Object.assign(filter, { [key]: query[key] });
  }
  if (access === "limited" && query.sort === "joined") {
    throw new DomainError("register_filter_not_allowed");
  }
  return filter;
}

function accessOf(authz: RequestAuthorization, clubId: string): RegisterAccess {
  // The policy (club.members.read) allowed the request, so there is access.
  const access = registerAccess(authz.actor, clubId);
  if (!access) throw new DomainError("not_allowed");
  return access;
}

@Controller("clubs")
export class MembersController {
  private readonly members: MembersService;
  private readonly memberships: MembershipsService;
  private readonly people: PeopleService;
  private readonly presenter: RegisterPresenter;
  private readonly intake: MemberIntakeService;

  constructor(
    members: MembersService,
    memberships: MembershipsService,
    people: PeopleService,
    presenter: RegisterPresenter,
    intake: MemberIntakeService,
  ) {
    this.members = members;
    this.memberships = memberships;
    this.people = people;
    this.presenter = presenter;
    this.intake = intake;
  }

  /**
   * "Add member" from a paper application (P1.3b): the person, membership,
   * groups, any number of guardians (members, new people without login, or
   * email invitations) and an adult's own-login invitation, in one
   * transaction. Answers with the new register row.
   */
  @Endpoint({
    method: "POST",
    path: ":clubId/members",
    summary: "Add a member by hand, with groups, guardians and invitations",
    tags: ["members"],
    access: { permission: "club.members.add", resource: "club" },
    request: { params: ClubParamsSchema, body: AddMemberSchema },
    response: AddMemberResultSchema,
    status: 201,
  })
  async add(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AddMemberInput,
  ): Promise<AddMemberResult> {
    const { clubId } = resourceOf(authz, "club");
    const result = await this.intake.addMember(tenantContext(authz, clubId), body);
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const row = await this.members.registerRow(context, result.personId);
    if (!row) throw new DomainError("not_found");
    const guardians = row.guardians.map((g) => g.personId);
    const people = await this.people.getPeople(context, [row.personId, ...guardians]);
    const [member] = await this.presenter.present(
      authz,
      clubId,
      "full",
      [row],
      new Map<string, RegisterPerson>(people.map((p) => [p.id, p])),
    );
    if (!member) throw new DomainError("not_found");
    return { member, invitationsSent: result.invitations };
  }

  /**
   * Three queries: the page (filters, groups, roles, consents and guardians
   * of the page's people; protected members left out by the database unless
   * the viewer may see them), the people (names; contact fields for full
   * access) and, once per request, the club's protected set (cached).
   */
  @Endpoint({
    method: "GET",
    path: ":clubId/members",
    summary: "The member register: search, filter and sort; fields by register access",
    tags: ["members"],
    access: { permission: "club.members.read", resource: "club" },
    request: { params: ClubParamsSchema, query: RegisterQuerySchema },
    response: RegisterPageSchema,
    bulkRead: true,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: RegisterQuery,
  ): Promise<RegisterPage> {
    const { clubId } = resourceOf(authz, "club");
    const access = accessOf(authz, clubId);
    const filter = registerFilterOf(query, access);
    const context = tenantContext(authz, clubId, { viewerPrivileged: access === "full" });
    const page = await this.members.registerPage(context, {
      filter,
      sort: query.sort,
      order: query.order,
      cursor: query.cursor,
      limit: query.limit,
    });
    const ids = page.items.map((r) => r.personId);
    let people: Map<string, RegisterPerson>;
    if (access === "full") {
      const guardians = page.items.flatMap((r) => r.guardians.map((g) => g.personId));
      const rows = await this.people.getPeople(context, [...new Set([...ids, ...guardians])]);
      people = new Map(rows.map((p) => [p.id, p]));
    } else {
      const rows = await this.people.summaries(context, ids);
      people = new Map(rows.map((p) => [p.id, p]));
    }
    return {
      access,
      items: await this.presenter.present(authz, clubId, access, page.items, people),
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/members/facets",
    summary: "Counts per membership status, type and group for the register's filters",
    tags: ["members"],
    access: { permission: "club.members.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: RegisterFacetsSchema,
  })
  async facets(@CurrentAuthorization() authz: RequestAuthorization): Promise<RegisterFacets> {
    const { clubId } = resourceOf(authz, "club");
    const access = accessOf(authz, clubId);
    const facets = await this.members.facets(tenantContext(authz, clubId));
    return {
      access,
      ...(access === "full" ? { statuses: facets.statuses } : {}),
      types: facets.types,
      groups: facets.groups,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: ":clubId/members/:personId/membership",
    summary:
      "Pause, resume or end a membership (ending also ends groups and roles), or change its type",
    tags: ["members"],
    access: { permission: "club.members.manage", resource: "club" },
    request: { params: MemberParamsSchema, body: UpdateMembershipSchema },
    response: MembershipResultSchema,
  })
  async updateMembership(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("personId") personId: string,
    @Body() body: UpdateMembershipInput,
  ): Promise<MembershipResult> {
    const { clubId } = resourceOf(authz, "club");
    const membership = await this.memberships.updateMembership(
      tenantContext(authz, clubId),
      personId,
      body,
    );
    if (membership.status === "applied") throw new DomainError("membership_status_invalid");
    return {
      personId,
      status: membership.status,
      membershipType: membership.membershipType,
      validFrom: membership.validFrom.toISOString(),
      validTo: membership.validTo ? membership.validTo.toISOString() : null,
    };
  }
}
