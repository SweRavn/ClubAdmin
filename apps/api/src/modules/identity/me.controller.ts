// SPDX-License-Identifier: AGPL-3.0-only
import {
  type GroupFunction,
  type MeResponse,
  MeResponseSchema,
  type MyClubs,
  MyClubsSchema,
  type MyGroups,
  MyGroupsSchema,
  type MyWards,
  MyWardsSchema,
  type Preferences,
  PreferencesSchema,
  SecurityResponseSchema,
  type SessionList,
  SessionListSchema,
  type UpdatePreferencesInput,
  UpdatePreferencesSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { AccountsService } from "../accounts/index.ts";
import {
  clubPermissions,
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { ClubsService } from "../clubs/index.ts";
import { type Group, GroupsService, toGroupResponse } from "../groups/index.ts";
import { PeopleService } from "../people/index.ts";
import { actorOf, CurrentPrincipal, type Principal, RequireMfa } from "./principal.ts";
import { SessionsService } from "./sessions.service.ts";

const SessionParams = z.object({ sessionId: z.string().min(1).max(100) });

@Controller("me")
export class MeController {
  private readonly people: PeopleService;
  private readonly clubs: ClubsService;
  private readonly sessions: SessionsService;
  private readonly presenter: PersonPresenter;
  private readonly accounts: AccountsService;
  private readonly groups: GroupsService;

  constructor(
    people: PeopleService,
    clubs: ClubsService,
    sessions: SessionsService,
    presenter: PersonPresenter,
    accounts: AccountsService,
    groups: GroupsService,
  ) {
    this.people = people;
    this.clubs = clubs;
    this.sessions = sessions;
    this.presenter = presenter;
    this.accounts = accounts;
    this.groups = groups;
  }

  @Endpoint({
    method: "GET",
    path: "",
    summary: "The logged-in person (creates the account on the first login)",
    tags: ["identity"],
    access: { authenticated: true },
    response: MeResponseSchema,
  })
  async me(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<MeResponse> {
    const context = actorOf(principal, request);
    const [person, preferences] = await Promise.all([
      this.people.getPerson(context, principal.personId),
      this.accounts.getPreferences(context),
    ]);
    return {
      personId: principal.personId,
      accountId: principal.accountId,
      mfa: principal.mfa,
      authTime: principal.authTime?.toISOString() ?? null,
      person: this.presenter.presentSelf(person),
      preferences,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: "preferences",
    summary: "Change my language, time zone or theme",
    tags: ["identity"],
    access: { authenticated: true },
    request: { body: UpdatePreferencesSchema },
    response: PreferencesSchema,
  })
  updatePreferences(
    @CurrentPrincipal() principal: Principal,
    @Body() body: UpdatePreferencesInput,
    @Req() request: FastifyRequest,
  ): Promise<Preferences> {
    // Always the logged-in person's own account, also when acting on behalf of a ward.
    return this.accounts.updatePreferences(actorOf(principal, request), body);
  }

  @Endpoint({
    method: "GET",
    path: "clubs",
    summary: "My clubs (or my ward's, with X-On-Behalf-Of): membership and roles",
    tags: ["identity"],
    access: { authenticated: true },
    response: MyClubsSchema,
  })
  async myClubs(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyClubs> {
    const { relationships } = authz.actor;
    const clubIds = authz.actor.clubIds();
    const clubs = await this.clubs.findClubs(authz.context, clubIds);
    return {
      clubs: clubs
        .map((club) => {
          const membership = relationships.memberships.find((m) => m.clubId === club.id);
          return {
            club: {
              id: club.id,
              name: club.name,
              shortName: club.shortName,
              slug: club.slug,
              country: club.country,
              logo: club.logo,
              defaultLocale: club.defaultLocale,
              timeZone: club.timeZone,
            },
            membership: membership
              ? { status: membership.status, membershipType: membership.membershipType }
              : null,
            roles: relationships.roles.filter((r) => r.clubId === club.id).map((r) => r.role),
            permissions: clubPermissions(authz.actor, club.id),
          };
        })
        .sort((a, b) => a.club.name.localeCompare(b.club.name)),
    };
  }

  @Endpoint({
    method: "GET",
    path: "groups",
    summary: "My groups and my wards' groups, with functions (the ward's own with X-On-Behalf-Of)",
    tags: ["identity"],
    access: { authenticated: true },
    response: MyGroupsSchema,
  })
  async myGroups(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyGroups> {
    const { groups: mine, wardGroups } = authz.actor.relationships;
    const all = [...mine, ...wardGroups];
    // One tenant transaction per club (a person's clubs are few), in parallel.
    const byClub = new Map<string, Set<string>>();
    for (const g of all) byClub.set(g.clubId, (byClub.get(g.clubId) ?? new Set()).add(g.groupId));
    const [clubs, ...loaded] = await Promise.all([
      this.clubs.findClubs(authz.context, [...byClub.keys()]),
      ...[...byClub].map(([clubId, ids]) =>
        this.groups.findGroups(tenantContext(authz, clubId), [...ids]),
      ),
    ]);
    const groups = new Map<string, Group>(loaded.flat().map((g) => [g.id, g]));
    const clubNames = new Map(clubs.map((c) => [c.id, c.name]));
    const entries = (rows: readonly { groupId: string; function: GroupFunction }[]) => {
      const functions = new Map<string, GroupFunction[]>();
      for (const r of rows)
        functions.set(r.groupId, [...(functions.get(r.groupId) ?? []), r.function]);
      return [...functions]
        .flatMap(([groupId, fns]) => {
          const group = groups.get(groupId);
          if (!group || group.archivedAt !== null) return [];
          return [
            {
              group: toGroupResponse(group),
              club: { id: group.clubId, name: clubNames.get(group.clubId) ?? "" },
              functions: fns,
            },
          ];
        })
        .sort(
          (a, b) =>
            a.club.name.localeCompare(b.club.name) || a.group.name.localeCompare(b.group.name),
        );
    };
    const wardIds = [...new Set(wardGroups.map((g) => g.personId))];
    return {
      groups: entries(mine),
      wards: wardIds.map((personId) => ({
        personId,
        groups: entries(wardGroups.filter((g) => g.personId === personId)),
      })),
    };
  }

  /**
   * Three queries: the wards (people), their clubs and which of them have a
   * login (only for wards the caller is a full guardian of); the protected
   * set is not needed (family sees family).
   */
  @Endpoint({
    method: "GET",
    path: "wards",
    summary:
      "The people I am a guardian of, with my rights (full guardians also see age, clubs and own login)",
    tags: ["identity"],
    access: { authenticated: true },
    response: MyWardsSchema,
  })
  async myWards(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyWards> {
    const { wards, wardMemberships } = authz.actor.relationships;
    const full = wards
      .filter((w) => w.kind === "parent" || w.kind === "legal_guardian")
      .map((w) => w.personId);
    const clubIds = [...new Set(wardMemberships.map((m) => m.clubId))];
    const [rows, clubs, withLogin] = await Promise.all([
      this.people.getPeople(
        authz.context,
        wards.map((w) => w.personId),
      ),
      this.clubs.findClubs(authz.context, clubIds),
      this.accounts.peopleWithAccount(authz.context, full),
    ]);
    const shown = new Map((await this.presenter.present(authz, null, rows)).map((p) => [p.id, p]));
    const people = new Map(rows.map((p) => [p.id, p]));
    const clubById = new Map(clubs.map((c) => [c.id, c]));
    return {
      wards: wards.flatMap((w) => {
        const person = shown.get(w.personId);
        if (!person) return [];
        const wardClubs = wardMemberships
          .filter(
            (m) => m.personId === w.personId && (m.status === "active" || m.status === "paused"),
          )
          .flatMap((m) => {
            const club = clubById.get(m.clubId);
            return club ? [{ id: club.id, name: club.name, country: club.country }] : [];
          });
        const isFull = full.includes(w.personId);
        return [
          {
            person,
            kind: w.kind,
            rights: w.rights,
            clubs: wardClubs.map(({ id, name }) => ({ id, name })),
            ...(isFull
              ? {
                  birthDate: people.get(w.personId)?.birthDate ?? null,
                  hasLogin: withLogin.has(w.personId),
                  ownLoginFromAge: this.accounts.ageRulesFor(wardClubs.map((c) => c.country))
                    .ownAccountMinAge,
                }
              : {}),
          },
        ];
      }),
    };
  }

  @RequireMfa()
  @Endpoint({
    method: "GET",
    path: "security",
    summary: "Security overview; needs a login with a second factor",
    tags: ["identity"],
    access: { authenticated: true },
    response: SecurityResponseSchema,
  })
  security(@CurrentPrincipal() principal: Principal): z.infer<typeof SecurityResponseSchema> {
    return { mfa: true, authTime: principal.authTime?.toISOString() ?? null };
  }

  @Endpoint({
    method: "GET",
    path: "sessions",
    summary: "My browser sessions",
    tags: ["identity"],
    access: { authenticated: true },
    response: SessionListSchema,
  })
  async listSessions(@CurrentPrincipal() principal: Principal): Promise<SessionList> {
    const sessions = await this.sessions.list(principal.personId);
    return {
      sessions: sessions.map((s) => ({
        ...s,
        current:
          principal.sessionId !== null &&
          (s.idpSessionId === principal.sessionId || s.id === principal.sessionId),
      })),
    };
  }

  @Endpoint({
    method: "DELETE",
    path: "sessions/:sessionId",
    summary: "Revoke one of my sessions (logs that browser out)",
    tags: ["identity"],
    access: { authenticated: true },
    request: { params: SessionParams },
    response: z.null(),
    status: 204,
  })
  async revokeSession(
    @CurrentPrincipal() principal: Principal,
    @Param() params: z.infer<typeof SessionParams>,
    @Req() request: FastifyRequest,
  ): Promise<null> {
    const context = { ...actorOf(principal, request), personId: principal.personId };
    if (!(await this.sessions.revoke(context, params.sessionId)))
      throw new ProblemError("not-found");
    return null;
  }
}
