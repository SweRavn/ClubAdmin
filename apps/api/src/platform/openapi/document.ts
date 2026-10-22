// SPDX-License-Identifier: AGPL-3.0-only
// Generates the OpenAPI document of the real application (no test routes),
// without connecting to any service.

import { createLogger } from "@clubadmin/server-kit";

import { createApp } from "../../app.ts";
import { loadApiConfig } from "../../config.ts";
import { EndpointRegistry } from "../http/endpoint-registry.ts";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.ts";

/** Committed copy used to generate the typed client (packages/api-client). */
export const OPENAPI_FILE = new URL(
  "../../../../../packages/api-client/openapi.json",
  import.meta.url,
);

export async function generateOpenApiDocument(): Promise<OpenApiDocument> {
  // With billing on, so the document (and the typed client) also describes the
  // billing routes; installations without billing simply do not serve them.
  const config = loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", BILLING_ENABLED: "true" });
  const app = await createApp(config, {
    logger: createLogger({ service: "openapi", level: "silent" }),
  });
  try {
    return buildOpenApiDocument(app.get(EndpointRegistry).all(), config.APP_VERSION);
  } finally {
    await app.close();
  }
}

export const serialiseOpenApi = (document: OpenApiDocument) =>
  `${JSON.stringify(document, null, 2)}\n`;
