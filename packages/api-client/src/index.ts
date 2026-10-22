// SPDX-License-Identifier: AGPL-3.0-only
// Typed client for the ClubAdmin API, used by the web and mobile apps.
// Types are generated from openapi.json (`pnpm api:client`).

import createClient, { type Client, type Middleware } from "openapi-fetch";

import type { components, paths } from "./schema.ts";

export { onBehalfApplies } from "./on-behalf.ts";
export type { components, paths } from "./schema.ts";
export type ProblemDetails = components["schemas"]["ProblemDetails"];

/** Thrown for every non-2xx response; carries the RFC 9457 problem details. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | undefined;
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying (Retry-After of a 429 answer). */
  readonly retryAfter: number | undefined;

  constructor(
    status: number,
    problem: ProblemDetails | undefined,
    requestId: string | undefined,
    retryAfter?: number,
  ) {
    super(problem?.title ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
    this.requestId = requestId ?? problem?.requestId;
    this.retryAfter = retryAfter;
  }

  /** The problem type slug, e.g. "validation" or "not-found". */
  get type(): string | undefined {
    return this.problem?.type.split("#").pop();
  }
}

export interface ApiClientOptions {
  /** Base URL, e.g. https://clubadmin.localhost. Paths already include /api/v1. */
  baseUrl: string;
  /** Preferred languages for translated error titles. */
  acceptLanguage?: string;
  /** Request ID generator; defaults to crypto.randomUUID. */
  requestId?: () => string;
  fetch?: typeof fetch;
}

export type ApiClient = Client<paths>;

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/, ""),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    credentials: "include",
  });
  const newRequestId = options.requestId ?? (() => crypto.randomUUID());

  // The hooks change headers in place and return nothing unless they replace
  // the request or response: openapi-fetch checks a returned value with
  // `instanceof Request/Response`, which fails in React Native, where fetch's
  // responses are not instances of the global Response class.
  const middleware: Middleware = {
    onRequest({ request }) {
      if (!request.headers.has("x-request-id")) request.headers.set("x-request-id", newRequestId());
      if (options.acceptLanguage) request.headers.set("accept-language", options.acceptLanguage);
      return undefined;
    },
    async onResponse({ response }) {
      if (response.ok) return undefined;
      const requestId = response.headers.get("x-request-id") ?? undefined;
      let problem: ProblemDetails | undefined;
      if (response.headers.get("content-type")?.includes("application/problem+json")) {
        problem = (await response.clone().json()) as ProblemDetails;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ApiError(
        response.status,
        problem,
        requestId,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    },
  };
  client.use(middleware);
  return client;
}
