// SPDX-License-Identifier: AGPL-3.0-only
// @Endpoint registers a route, its request/response schemas (validation and
// OpenAPI) and its access rule in one place. Every route must use it; a route
// declared with plain @Get/@Post fails at startup (see endpoint-registry.ts).

import type { z } from "@clubadmin/shared";
import { applyDecorators, HttpCode, RequestMethod, SetMetadata } from "@nestjs/common";
import { RequestMapping } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";

export const ENDPOINT_METADATA = "clubadmin:endpoint";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call the endpoint. `public` needs no login. Permissions are checked
 * by the authorization module (P0.7); until then only public endpoints exist.
 */
export type EndpointAccess = { public: true } | { permission: string };

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
  /** Override the global rate limit for this route. */
  rateLimit?: { max: number; timeWindowMs: number };
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
