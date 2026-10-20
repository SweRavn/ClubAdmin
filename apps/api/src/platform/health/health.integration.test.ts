// SPDX-License-Identifier: AGPL-3.0-only
// Needs the local services: pnpm dev:services, then pnpm test:integration.
import { loadEnvFiles } from "@clubadmin/server-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, type TestApp } from "../../testing/test-app.ts";

loadEnvFiles();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    DATABASE_URL: process.env.DATABASE_URL,
    VALKEY_URL: process.env.VALKEY_URL,
  });
});
afterAll(async () => {
  await t.close();
});

describe("with PostgreSQL and Valkey", () => {
  it("is ready when both are reachable", async () => {
    const res = await t.app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      checks: { database: { status: "ok" }, valkey: { status: "ok" } },
    });
  });

  it("keeps rate-limit counters in Valkey", async () => {
    const ip = `10.${Math.floor(Math.random() * 250)}.1.1`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await t.app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url: "/api/v1/test/limited", remoteAddress: ip });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
