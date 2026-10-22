// SPDX-License-Identifier: AGPL-3.0-only
// What the authorization module attaches to a request: the actor (relations
// loaded once per request), the context for domain services (records actor
// and on-behalf-of in history and audit), the resource the endpoint's policy
// was checked against, and per-request memos.

import type { ActorContext, TenantContext } from "@clubadmin/db";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { Principal } from "../../platform/http/principal.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { Resource, Resources } from "./policy.ts";
import type { Actor } from "./relationship-set.ts";

export interface RequestAuthorization {
  principal: Principal;
  actor: Actor;
  /** For domain services: the logged-in person, and the ward when acting on behalf. */
  context: ActorContext;
  /** The resource the endpoint's permission was checked against. */
  resource: Resource | null;
  /** Protected sets per club, loaded at most once per request. */
  protectedSets: Map<string, Promise<ReadonlySet<string>>>;
}

declare module "fastify" {
  interface FastifyRequest {
    authz?: RequestAuthorization;
  }
}

/** The service context in a club (for withTenant). */
export function tenantContext(
  authorization: RequestAuthorization,
  clubId: string,
  options: { viewerPrivileged?: boolean } = {},
): TenantContext {
  return {
    ...authorization.context,
    clubId,
    ...(options.viewerPrivileged ? { viewerPrivileged: true } : {}),
  };
}

/** The checked resource of the expected kind (set by the guard for permission endpoints). */
export function resourceOf<K extends keyof Resources>(
  authorization: RequestAuthorization,
  kind: K,
): Resources[K] {
  const resource = authorization.resource;
  if (resource?.kind !== kind) throw new Error(`endpoint has no ${kind} resource`);
  return resource as Resources[K];
}

/** The request's authorization (endpoints with access `authenticated` or a permission). */
export const CurrentAuthorization = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAuthorization => {
    const authorization = ctx.switchToHttp().getRequest<FastifyRequest>().authz;
    if (!authorization) throw new ProblemError("unauthenticated");
    return authorization;
  },
);

/** The service context an operator acts in (row-level security: app.is_platform_operator()). */
export const operatorTenant = (
  context: { personId?: string | null; requestId?: string | null },
  clubId: string,
): TenantContext => ({
  actorKind: "operator",
  personId: context.personId ?? null,
  requestId: context.requestId ?? null,
  clubId,
});

/** An operator acting outside a club (global tables, e.g. club creation requests). */
export const operatorActor = (context: {
  personId?: string | null;
  requestId?: string | null;
}): ActorContext => ({
  actorKind: "operator",
  personId: context.personId ?? null,
  requestId: context.requestId ?? null,
});
