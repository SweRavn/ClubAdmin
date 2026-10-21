// SPDX-License-Identifier: AGPL-3.0-only
import {
  type MeResponse,
  MeResponseSchema,
  type MyClubs,
  MyClubsSchema,
  type MyWards,
  MyWardsSchema,
  SecurityResponseSchema,
  type SessionList,
  SessionListSchema,
  z,
} from "@clubadmin/shared";
import { Controller, Param, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
} from "../authorization/index.ts";
import { ClubsService } from "../clubs/index.ts";
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

  constructor(
    people: PeopleService,
    clubs: ClubsService,
    sessions: SessionsService,
    presenter: PersonPresenter,
  ) {
    this.people = people;
    this.clubs = clubs;
    this.sessions = sessions;
    this.presenter = presenter;
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
    const person = await this.people.getPerson(actorOf(principal, request), principal.personId);
    return {
      personId: principal.personId,
      accountId: principal.accountId,
      mfa: principal.mfa,
      authTime: principal.authTime?.toISOString() ?? null,
      person: this.presenter.presentSelf(person),
    };
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
            },
            membership: membership
              ? { status: membership.status, membershipType: membership.membershipType }
              : null,
            roles: relationships.roles.filter((r) => r.clubId === club.id).map((r) => r.role),
          };
        })
        .sort((a, b) => a.club.name.localeCompare(b.club.name)),
    };
  }

  @Endpoint({
    method: "GET",
    path: "wards",
    summary: "The people I am a guardian of, with my rights",
    tags: ["identity"],
    access: { authenticated: true },
    response: MyWardsSchema,
  })
  async myWards(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyWards> {
    const { wards } = authz.actor.relationships;
    const rows = await this.people.summaries(
      authz.context,
      wards.map((w) => w.personId),
    );
    const shown = new Map((await this.presenter.present(authz, null, rows)).map((p) => [p.id, p]));
    return {
      wards: wards.flatMap((w) => {
        const person = shown.get(w.personId);
        return person ? [{ person, kind: w.kind, rights: w.rights }] : [];
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
