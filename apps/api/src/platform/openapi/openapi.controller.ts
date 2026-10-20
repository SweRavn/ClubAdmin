// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "@clubadmin/shared";
import { Controller, Inject } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../http/endpoint.ts";
import { EndpointRegistry } from "../http/endpoint-registry.ts";
import { ProblemError } from "../http/problem-error.ts";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.ts";

@Controller()
export class OpenApiController {
  private readonly registry: EndpointRegistry;
  private readonly config: ApiConfig;
  private document: OpenApiDocument | undefined;

  constructor(registry: EndpointRegistry, @Inject(API_CONFIG) config: ApiConfig) {
    this.registry = registry;
    this.config = config;
  }

  @Endpoint({
    method: "GET",
    path: "openapi.json",
    summary: "OpenAPI document (development only)",
    access: { public: true },
    response: z.looseObject({ openapi: z.string() }),
    hidden: true,
  })
  get(): OpenApiDocument {
    if (!this.config.OPENAPI_ENABLED) throw new ProblemError("not-found");
    this.document ??= buildOpenApiDocument(this.registry.all(), this.config.APP_VERSION);
    return this.document;
  }
}
