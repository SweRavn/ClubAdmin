// SPDX-License-Identifier: AGPL-3.0-only
// @Endpoint registers a route, its request/response schemas (validation and
// OpenAPI) and its access rule in one place. Every route must use it; a route
// declared with plain @Get/@Post fails at startup (see endpoint-registry.ts).

import type { Permission, z } from "@clubadmin/shared";
import { applyDecorators, HttpCode, RequestMethod, SetMetadata } from "@nestjs/common";
import { RequestMapping } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";

export const ENDPOINT_METADATA = "clubadmin:endpoint";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Which resource the authorization module loads for the policy (from
 * :clubId, :groupId, :personId; "platform": the installation, for operators).
 */
export type EndpointResource = "platform" | "club" | "group" | "person";

/**
 * Who may call the endpoint: `public` needs no login, `authenticated` any
 * logged-in person (their own data, e.g. /me), `permission` a permission
 * whose policy the authorization module evaluates against the `resource`
 * (ADR 0006). The AuthGuard (identity module) enforces it; @RequireMfa() and
 * @RecentAuth() add step-up requirements.
 */
export type EndpointAccess =
  | { public: true }
  | { authenticated: true }
  | { permission: Permission; resource: EndpointResource };

export interface EndpointOptions {
  method: HttpMethod;
  path: string;
  summary: string;
  tags?: string[];
  access: EndpointAccess;
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodType;
  };
  /** Successful response body. Output is validated and unknown fields are stripped. */
  response: z.ZodType;
  status?: number;
  /** Override the global per-IP rate limit for this route. */
  rateLimit?: { max: number; timeWindowMs: number };
  /**
   * Pages through a club's people (rosters, later exports): also counts
   * against the per-club and per-account bulk-read budgets. Needs a club or
   * group resource.
   */
  bulkRead?: boolean;
  /**
   * Restricted clubs (P0.12, entitlements module): by default a read-only
   * club refuses writes and a suspended club everything. "export": always
   * works (data exports, ADR 0013). "exempt": operator endpoints that change
   * the restriction itself.
   */
  clubAccess?: "export" | "exempt";
  /** Leave out of the OpenAPI document. */
  hidden?: boolean;
}

const METHODS: Record<HttpMethod, RequestMethod> = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PUT: RequestMethod.PUT,
  PATCH: RequestMethod.PATCH,
  DELETE: RequestMethod.DELETE,
};

export function Endpoint(options: EndpointOptions): MethodDecorator {
  const decorators: (MethodDecorator | ClassDecorator)[] = [
    RequestMapping({ path: options.path, method: METHODS[options.method] }),
    SetMetadata(ENDPOINT_METADATA, options),
    HttpCode(options.status ?? (options.method === "POST" ? 201 : 200)),
  ];
  if (options.rateLimit) {
    decorators.push(
      RouteConfig({
        rateLimit: { max: options.rateLimit.max, timeWindow: options.rateLimit.timeWindowMs },
      }),
    );
  }
  return applyDecorators(...decorators);
}
