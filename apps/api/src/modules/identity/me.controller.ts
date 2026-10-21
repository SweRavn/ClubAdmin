// SPDX-License-Identifier: AGPL-3.0-only
import {
  type MeResponse,
  MeResponseSchema,
  SecurityResponseSchema,
  type SessionList,
  SessionListSchema,
  z,
} from "@clubadmin/shared";
import { Controller, Param, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { presentPerson } from "../../platform/visibility/person-presenter.ts";
import { PeopleService } from "../people/index.ts";
import { actorOf, CurrentPrincipal, type Principal, RequireMfa } from "./principal.ts";
import { SessionsService } from "./sessions.service.ts";

const SessionParams = z.object({ sessionId: z.string().min(1).max(100) });

@Controller("me")
export class MeController {
  private readonly people: PeopleService;
  private readonly sessions: SessionsService;

  constructor(people: PeopleService, sessions: SessionsService) {
    this.people = people;
    this.sessions = sessions;
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
      person: presentPerson(principal.personId, person),
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
