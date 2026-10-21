// SPDX-License-Identifier: AGPL-3.0-only
// Deny by default (CLAUDE.md rule 2): the API refuses to start when an
// endpoint's permission has no matching policy (routes without @Endpoint:
// app.test.ts).

import { z } from "@clubadmin/shared";
import { Controller, Module } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import { loadApiConfig } from "../../config.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  EndpointRegistry,
  type RegisteredEndpoint,
} from "../../platform/http/endpoint-registry.ts";
import { endpointPolicyProblems } from "./endpoint-policies.ts";

const endpoint = (overrides: Partial<RegisteredEndpoint>): RegisteredEndpoint => ({
  method: "GET",
  path: "",
  summary: "test",
  access: { permission: "group.read", resource: "group" },
  response: z.object({}),
  fullPath: "/api/v1/groups/:groupId",
  controller: "TestController",
  handler: "get",
  ...overrides,
});

describe("endpoint policies", () => {
  it("accepts a permission with its policy's resource and path parameter", () => {
    expect(endpointPolicyProblems([endpoint({})])).toEqual([]);
  });

  it("refuses an unknown permission, a mismatched resource or a missing parameter", () => {
    const problems = endpointPolicyProblems([
      endpoint({ access: { permission: "nope.read" as never, resource: "group" } }),
      endpoint({
        access: { permission: "group.read", resource: "club" },
        fullPath: "/api/v1/clubs/:clubId",
      }),
      endpoint({ fullPath: "/api/v1/groups" }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/no policy for nope\.read/);
    expect(problems[1]).toMatch(/checks a group, not a club/);
    expect(problems[2]).toMatch(/needs the path parameter :groupId/);
  });

  it("every endpoint of the API declares public, authenticated or a valid permission", async () => {
    const app = await createApp(loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "fatal" }), {
      modules: [],
    });
    try {
      const endpoints = app.get(EndpointRegistry).all();
      expect(endpoints.length).toBeGreaterThan(5);
      expect(endpointPolicyProblems(endpoints)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("refuses to start with a permission that has no policy", async () => {
    @Controller("bogus")
    class BogusController {
      @Endpoint({
        method: "GET",
        path: ":clubId",
        summary: "Bogus",
        access: { permission: "club.delete" as never, resource: "club" },
        response: z.object({}),
      })
      get(): object {
        return {};
      }
    }
    @Module({ controllers: [BogusController] })
    class BogusModule {}
    await expect(
      createApp(loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "fatal" }), {
        modules: [BogusModule],
      }),
    ).rejects.toThrow(/no policy for club\.delete/);
  });
});
