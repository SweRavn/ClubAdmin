// SPDX-License-Identifier: AGPL-3.0-only
import { Controller, Get, Module } from "@nestjs/common";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, type TestApp } from "./testing/test-app.ts";

let t: TestApp;
const inject = (options: InjectOptions) => t.app.getHttpAdapter().getInstance().inject(options);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("health", () => {
  it("live answers ok with a request ID", async () => {
    const res = await inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("ready reports skipped checks when no database or Valkey is configured", async () => {
    const res = await inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      checks: {
        database: { status: "skipped" },
        valkey: { status: "skipped" },
        migrations: { status: "skipped" },
      },
    });
  });
});

describe("request IDs", () => {
  it("keeps a valid incoming X-Request-Id", async () => {
    const id = "0190f0e0-1234-7abc-8def-0123456789ab";
    const res = await inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": id },
    });
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it("replaces an invalid incoming X-Request-Id", async () => {
    const res = await inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "<script>" },
    });
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("meta", () => {
  it("returns version and AGPL source information", async () => {
    const version = await inject({ method: "GET", url: "/api/v1/meta/version" });
    expect(version.json()).toEqual({ version: "0.0.0", commit: "unknown" });
    const source = await inject({ method: "GET", url: "/api/v1/meta/source" });
    expect(source.json()).toEqual({
      url: "https://github.com/SweRavn/ClubAdmin",
      license: "AGPL-3.0-only",
      commit: "unknown",
    });
  });

  it("sets security headers", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/meta/version" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("validation and problem details", () => {
  it("answers 400 with field errors for an invalid body", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/v1/test/echo",
      payload: { email: "nope", count: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: expect.stringMatching(/#validation$/) as unknown,
      title: "The request contains invalid data",
      status: 400,
      instance: "/api/v1/test/echo",
      requestId: res.headers["x-request-id"],
    });
    expect(body.errors).toEqual([
      expect.objectContaining({ location: "body", path: "email", code: "invalid_format" }),
      expect.objectContaining({ location: "body", path: "count", code: "too_small" }),
    ]);
    // The invalid input itself is never echoed back.
    expect(res.body).not.toContain("nope");
  });

  it("translates the title from Accept-Language", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/v1/test/echo",
      payload: {},
      headers: { "accept-language": "sv-SE,sv;q=0.9" },
    });
    expect(res.json<{ title: string }>().title).toBe("Förfrågan innehåller ogiltiga uppgifter");
  });

  it("strips fields that are not in the response schema", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/v1/test/echo",
      payload: { email: "a@example.test", count: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
  });

  it("answers 500 without internals for unexpected errors", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/test/crash" });
    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 500, title: "Something went wrong on our side" });
    expect(body.requestId).toMatch(UUID);
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("stack");
    expect(res.body).not.toContain(".ts:");
  });

  it("passes on the detail of a ProblemError", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/test/conflict" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      status: 409,
      detail: "The group was changed by someone else.",
    });
  });

  it("answers 404 problem details for unknown routes", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/nope?x=1" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 404, instance: "/api/v1/nope" });
  });

  it("answers 400 for malformed JSON and 413 for oversized bodies", async () => {
    const malformed = await inject({
      method: "POST",
      url: "/api/v1/test/echo",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/problem+json");

    const huge = await inject({
      method: "POST",
      url: "/api/v1/test/echo",
      payload: JSON.stringify({ email: "a@example.test", count: 1, pad: "x".repeat(1_100_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({
      status: 413,
      type: expect.stringMatching(/#payload-too-large$/) as unknown,
    });
  });

  it("rate limits per route with 429 problem details and Retry-After", async () => {
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await inject({
        method: "GET",
        url: "/api/v1/test/limited",
        remoteAddress: "10.9.9.9",
      });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(last?.json()).toMatchObject({
      status: 429,
      type: expect.stringMatching(/#rate-limited$/) as unknown,
    });
  });
});

describe("logging", () => {
  it("never writes request bodies, query strings or error details with personal data to the logs", async () => {
    await inject({
      method: "POST",
      url: "/api/v1/test/echo?search=Lindqvist",
      payload: { email: "anna.lindqvist@example.test", count: 1 },
    });
    await inject({ method: "GET", url: "/api/v1/test/crash" });
    const raw = t.rawLogs();
    expect(raw).not.toContain("anna.lindqvist@example.test");
    expect(raw).not.toContain("Lindqvist");
    const requestLog = t.logs.findLast(
      (l) => l.msg === "request" && l.route === "/api/v1/test/echo",
    );
    expect(requestLog).toMatchObject({
      method: "POST",
      status: 200,
      requestId: expect.any(String) as unknown,
    });
    expect(t.logs.some((l) => l.msg === "unhandled error" && l.level === "error")).toBe(true);
  });
});

describe("startup checks", () => {
  it("refuses to start when a route is declared without @Endpoint", async () => {
    @Controller("bad")
    class BadController {
      @Get("route")
      route(): string {
        return "no schema";
      }
    }
    @Module({ controllers: [BadController] })
    class BadModule {}
    await expect(createTestApp({}, [BadModule])).rejects.toThrow(/BadController\.route/);
  });

  it("refuses to start with invalid configuration, naming the variable", async () => {
    await expect(createTestApp({ API_PORT: "not-a-port" })).rejects.toThrow(/API_PORT/);
  });
});
