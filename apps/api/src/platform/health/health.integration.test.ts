// SPDX-License-Identifier: AGPL-3.0-only
// Needs the local services: pnpm dev:services, then pnpm test:integration.
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, type TestApp } from "../../testing/test-app.ts";

loadEnvFiles();
let t: TestApp;
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  t = await createTestApp({
    DATABASE_URL: database.url("app"),
    VALKEY_URL: process.env.VALKEY_URL,
  });
});
afterAll(async () => {
  await t.close();
  await database.drop();
});

const inject = (url: string, remoteAddress?: string) =>
  t.app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: "GET", url, ...(remoteAddress ? { remoteAddress } : {}) });

describe("with PostgreSQL and Valkey", () => {
  it("is ready when both are reachable and all migrations are applied", async () => {
    const res = await inject("/health/ready");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      checks: {
        database: { status: "ok" },
        valkey: { status: "ok" },
        migrations: { status: "ok" },
      },
    });
  });

  it("is not ready when an applied migration was edited", async () => {
    const original = await database.query<{ checksum: string }>(
      "owner",
      "SELECT checksum FROM app_meta.schema_migrations WHERE name = '0000_foundation'",
    );
    await database.query(
      "owner",
      "UPDATE app_meta.schema_migrations SET checksum = 'x' WHERE name = '0000_foundation'",
    );
    const res = await inject("/health/ready");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      checks: { migrations: { status: "fail", detail: "changed migrations: 0000_foundation" } },
    });
    await database.query(
      "owner",
      "UPDATE app_meta.schema_migrations SET checksum = $1 WHERE name = '0000_foundation'",
      [original.rows[0]?.checksum],
    );
  });

  it("keeps rate-limit counters in Valkey", async () => {
    const ip = `10.${Math.floor(Math.random() * 250)}.1.1`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await inject("/api/v1/test/limited", ip)).statusCode);
    expect(statuses).toEqual([200, 200, 429]);
  });
});
