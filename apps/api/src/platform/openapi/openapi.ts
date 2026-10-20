// SPDX-License-Identifier: AGPL-3.0-only
// Builds the OpenAPI 3.1 document from the @Endpoint declarations.

import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { PROBLEM_CONTENT_TYPE, ProblemDetailsSchema } from "@clubadmin/shared";

import type { RegisteredEndpoint } from "../http/endpoint-registry.ts";

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema } },
});

/** Nest-style `:id` path parameters → OpenAPI `{id}`. */
export const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

export function buildOpenApiDocument(
  endpoints: readonly RegisteredEndpoint[],
  version: string,
): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.register("ProblemDetails", ProblemDetailsSchema);

  for (const endpoint of endpoints) {
    if (endpoint.hidden) continue;
    const status = endpoint.status ?? (endpoint.method === "POST" ? 201 : 200);
    const route: RouteConfig = {
      method: endpoint.method.toLowerCase() as RouteConfig["method"],
      path: toOpenApiPath(endpoint.fullPath),
      operationId: `${endpoint.controller.replace(/Controller$/, "")}_${endpoint.handler}`,
      summary: endpoint.summary,
      tags: endpoint.tags ?? [],
      request: {
        ...(endpoint.request?.params ? { params: endpoint.request.params } : {}),
        ...(endpoint.request?.query ? { query: endpoint.request.query } : {}),
        ...(endpoint.request?.body
          ? {
              body: {
                content: { "application/json": { schema: endpoint.request.body } },
                required: true,
              },
            }
          : {}),
      },
      responses: {
        [status]: {
          description: "Success",
          content: { "application/json": { schema: endpoint.response } },
        },
        ...(endpoint.request ? { 400: problemResponse("Invalid request") } : {}),
        429: problemResponse("Too many requests"),
        500: problemResponse("Unexpected error"),
      },
    };
    if ("permission" in endpoint.access) {
      route.description = `Requires permission \`${endpoint.access.permission}\`.`;
    }
    registry.registerPath(route);
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "ClubAdmin API",
      version,
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
      description:
        "REST API of ClubAdmin. Errors use RFC 9457 problem details (application/problem+json).",
    },
    servers: [{ url: "/" }],
  });
}
