// SPDX-License-Identifier: AGPL-3.0-only
// Global guard: every request with a bearer token is authenticated; endpoints
// that are not public require it, and endpoints with a permission are
// authorized by the authorization module (deny by default, ADR 0006).
// Tokens and their contents are never logged.

import {
  ACCOUNT_INVITATION_HEADER,
  type EntitlementFeature,
  ID_TOKEN_HEADER,
} from "@clubadmin/shared";
import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { ENDPOINT_METADATA, type EndpointOptions } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { AuthorizationService } from "../authorization/index.ts";
import { type EntitlementsService, REQUIRES_ENTITLEMENT } from "../entitlements/index.ts";
import type { IdentityService } from "./identity.service.ts";
import { RECENT_AUTH, REQUIRE_MFA } from "./principal.ts";
import type { RequestLimits } from "./request-limits.ts";
import type { SessionsService } from "./sessions.service.ts";
import { TokenError, type TokenVerifier } from "./token-verifier.ts";

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector: Reflector;
  private readonly verifier: TokenVerifier;
  private readonly identity: IdentityService;
  private readonly authorization: AuthorizationService;
  private readonly limits: RequestLimits;
  private readonly sessions: SessionsService;
  /** OIDC clients whose sessions are registered in /me/sessions by the API (the mobile app). */
  private readonly mobileClients: ReadonlySet<string>;
  private readonly entitlements: EntitlementsService;

  constructor(
    reflector: Reflector,
    verifier: TokenVerifier,
    identity: IdentityService,
    authorization: AuthorizationService,
    limits: RequestLimits,
    sessions: SessionsService,
    mobileClients: ReadonlySet<string>,
    entitlements: EntitlementsService,
  ) {
    this.reflector = reflector;
    this.verifier = verifier;
    this.identity = identity;
    this.authorization = authorization;
    this.limits = limits;
    this.sessions = sessions;
    this.mobileClients = mobileClients;
    this.entitlements = entitlements;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const endpoint = this.reflector.get<EndpointOptions | undefined>(
      ENDPOINT_METADATA,
      context.getHandler(),
    );
    // Routes without @Endpoint do not exist (EndpointRegistry); deny anyway.
    if (!endpoint) throw new ProblemError("forbidden");
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const isPublic = "public" in endpoint.access;

    const authorization = header(request, "authorization");
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer) {
      if (isPublic) return true;
      throw new ProblemError("unauthenticated");
    }

    let verified;
    try {
      verified = await this.verifier.verify(bearer, header(request, ID_TOKEN_HEADER));
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      // It escaped the unauthenticated per-IP limit (app.ts) by carrying a token.
      await this.limits.rejectedToken(request.ip);
      // A bad token on a public endpoint is ignored rather than refused.
      if (isPublic) return true;
      request.log.info({ reason: error.message }, "access token rejected");
      throw new ProblemError("unauthenticated");
    }
    const invitation = header(request, ACCOUNT_INVITATION_HEADER);
    request.principal = await this.identity.resolve(verified, {
      requestId: request.id,
      ip: request.ip,
      ...(invitation ? { invitationToken: invitation } : {}),
    });
    await this.limits.account(request.principal);
    if (endpoint.accountLimit === "joining") await this.limits.joining(request.principal);
    if (verified.clientId && verified.sessionId && this.mobileClients.has(verified.clientId)) {
      // A revoked app session stays revoked, even with refreshed tokens (ADR 0028).
      if (await this.sessions.isRevoked(verified.sessionId)) {
        delete request.principal;
        if (isPublic) return true;
        throw new ProblemError("unauthenticated", { detail: "session_revoked" });
      }
      this.sessions.touchMobile(
        request.principal.personId,
        verified.sessionId,
        request,
        request.principal.dev,
      );
    }

    // Public endpoints never act on the caller's relationships.
    if (isPublic) return true;

    request.authz = await this.authorization.forRequest(request, request.principal);
    if ("permission" in endpoint.access) {
      await this.authorization.authorize(request.authz, endpoint.access.permission, request);
    }
    if (endpoint.bulkRead) {
      const resource = request.authz.resource;
      if (resource?.kind !== "club" && resource?.kind !== "group" && resource?.kind !== "event") {
        throw new Error("bulkRead endpoints need a club, group or event resource");
      }
      await this.limits.bulkRead(request.principal, resource.clubId);
    }
    const handler = context.getHandler();
    const controller = context.getClass();
    // The club's access state (read-only, suspended) and the endpoint's entitlement (P0.12).
    const resource = request.authz.resource;
    await this.entitlements.enforce({
      clubId: resource && "clubId" in resource ? resource.clubId : null,
      method: request.method,
      feature: this.reflector.get<EntitlementFeature | undefined>(REQUIRES_ENTITLEMENT, handler),
      clubAccess: endpoint.clubAccess ?? "default",
    });
    const needsMfa = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_MFA, [
      handler,
      controller,
    ]);
    if (needsMfa && !request.principal.mfa) {
      throw new ProblemError("mfa-required", { detail: "mfa_required" });
    }
    const recentMinutes = this.reflector.getAllAndOverride<number | undefined>(RECENT_AUTH, [
      handler,
      controller,
    ]);
    if (recentMinutes !== undefined) {
      const authTime = request.principal.authTime?.getTime() ?? 0;
      if (Date.now() - authTime > recentMinutes * 60_000) {
        throw new ProblemError("reauthentication-required", { detail: "recent_auth_required" });
      }
    }
    return true;
  }
}
