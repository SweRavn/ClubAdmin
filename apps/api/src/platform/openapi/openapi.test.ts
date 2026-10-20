// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { generateOpenApiDocument, OPENAPI_FILE, serialiseOpenApi } from "./document.ts";
import { toOpenApiPath } from "./openapi.ts";

describe("OpenAPI document", () => {
  it("describes every endpoint with problem-details error responses", async () => {
    const document = await generateOpenApiDocument();
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths ?? {})).toEqual(
      expect.arrayContaining([
        "/health/live",
        "/health/ready",
        "/api/v1/meta/version",
        "/api/v1/meta/source",
      ]),
    );
    expect(document.paths?.["/api/v1/openapi.json"]).toBeUndefined();
    const version = document.paths?.["/api/v1/meta/version"]?.get;
    expect(Object.keys(version?.responses ?? {})).toEqual(["200", "429", "500"]);
    expect(document.components?.schemas?.ProblemDetails).toBeDefined();
  });

  it("matches the committed packages/api-client/openapi.json (run `pnpm api:client`)", async () => {
    const committed = readFileSync(OPENAPI_FILE, "utf8");
    expect(serialiseOpenApi(await generateOpenApiDocument())).toBe(committed);
  });

  it("converts path parameters", () => {
    expect(toOpenApiPath("/api/v1/groups/:groupId/members/:personId")).toBe(
      "/api/v1/groups/{groupId}/members/{personId}",
    );
  });
});
