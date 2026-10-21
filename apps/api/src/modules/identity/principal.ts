// SPDX-License-Identifier: AGPL-3.0-only
// Who is calling: resolved from the access token by the AuthGuard and stored
// on the request. Decorators for endpoints that need more than a login.

import type { ActorContext } from "@clubadmin/db";
import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { Principal } from "../../platform/http/principal.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";

export type { Principal };

export const REQUIRE_MFA = "clubadmin:require-mfa";
export const RECENT_AUTH = "clubadmin:recent-auth";

/** The endpoint needs a login with a second factor (403 mfa-required otherwise). */
export const RequireMfa = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_MFA, true);

/** The endpoint needs a login within the last `minutes` (403 reauthentication-required otherwise). */
export const RecentAuth = (minutes: number): MethodDecorator & ClassDecorator =>
  SetMetadata(RECENT_AUTH, minutes);

/** The authenticated principal (endpoints with access `authenticated` or a permission). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<FastifyRequest>().principal;
    if (!principal) throw new ProblemError("unauthenticated");
    return principal;
  },
);

/** The actor context for domain services. */
export function actorOf(principal: Principal, request: FastifyRequest): ActorContext {
  return { actorKind: "person", personId: principal.personId, requestId: request.id };
}
