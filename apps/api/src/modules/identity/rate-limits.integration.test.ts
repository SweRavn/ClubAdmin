// SPDX-License-Identifier: AGPL-3.0-only
// Rate limits through the HTTP API (docs/security.md, "Rate limits"):
// unauthenticated requests per IP, authenticated requests per account with a
// per-IP backstop, bulk reads per club and per account, and first-login
// provisioning shared across API instances through Valkey (#7, #11).

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { ID_TOKEN_HEADER, uuidv7 } from "@clubadmin/shared";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  devToken,
  type FakeIssuer,
  startFakeIssuer,
  TEST_AUDIENCE,
  TEST_DEV_AUTH_KEY,
} from "../../testing/oidc.ts";
import { buildMatrixScenario, type MatrixScenario } from "../../testing/scenarios.ts";
import { createCoreServices } from "../../testing/services.ts";
import { createTestApp, type TestApp } from "../../testing/test-app.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";

let t: TestDatabase;
let m: MatrixScenario;
let issuer: FakeIssuer;
let app: TestApp;

const limits = {
  RATE_LIMIT_MAX: "5",
  RATE_LIMIT_ACCOUNT_MAX: "4",
  RATE_LIMIT_IP_BACKSTOP: "10",
  RATE_LIMIT_CLUB_BULK_MAX: "3",
  RATE_LIMIT_ACCOUNT_BULK_MAX: "100",
};

const baseEnv = (t: TestDatabase, valkeyUrl: string) => ({
  NODE_ENV: "development",
  DATABASE_URL: t.url("app"),
  VALKEY_URL: valkeyUrl,
  AUTH_ISSUER: issuer.issuer,
  AUTH_AUDIENCE: TEST_AUDIENCE,
  AUTH_JWKS_URL: issuer.jwksUrl,
  DEV_AUTH: "true",
  DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
});

beforeAll(async () => {
  t = await createTestDatabase();
  m = await buildMatrixScenario(createCoreServices(t.db), t);
  issuer = await startFakeIssuer();
  app = await createTestApp({ ...baseEnv(t, VALKEY_URL), ...limits }, []);
});
afterAll(async () => {
  await app?.close();
  await issuer?.close();
  await t?.drop();
});

/** A fresh client address per test, so counters from other tests (or runs) never interfere. */
const freshIp = () => {
  const n = Number.parseInt(uuidv7().slice(-6), 16);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

const inject = (target: TestApp, options: InjectOptions) =>
  target.app.getHttpAdapter().getInstance().inject(options);

async function asPerson(
  personId: string,
  ip: string,
  url = "/api/v1/me",
  target: TestApp = app,
): Promise<LightMyRequestResponse> {
  return inject(target, {
    method: "GET",
    url,
    remoteAddress: ip,
    headers: { authorization: `Bearer ${await devToken(personId)}` },
  });
}

async function statuses(count: number, request: () => Promise<LightMyRequestResponse>) {
  const result: number[] = [];
  for (let i = 0; i < count; i += 1) result.push((await request()).statusCode);
  return result;
}

describe("unauthenticated requests", () => {
  it("are limited per IP", async () => {
    const ip = freshIp();
    const get = () =>
      inject(app, { method: "GET", url: "/api/v1/meta/version", remoteAddress: ip });
    expect(await statuses(6, get)).toEqual([200, 200, 200, 200, 200, 429]);
    // Another address has its own budget.
    expect(
      (await inject(app, { method: "GET", url: "/api/v1/meta/version", remoteAddress: freshIp() }))
        .statusCode,
    ).toBe(200);
  });

  it("count rejected tokens like requests without one", async () => {
    const ip = freshIp();
    const get = () =>
      inject(app, {
        method: "GET",
        url: "/api/v1/me",
        remoteAddress: ip,
        headers: { authorization: "Bearer not-a-token" },
      });
    expect(await statuses(6, get)).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("authenticated requests", () => {
  it("are limited per account, with Retry-After", async () => {
    const ip = freshIp();
    const results = await statuses(5, () => asPerson(m.member.id, ip));
    expect(results).toEqual([200, 200, 200, 200, 429]);
    const limited = await asPerson(m.member.id, ip);
    expect(limited.json()).toMatchObject({
      status: 429,
      type: expect.stringMatching(/#rate-limited$/) as unknown,
    });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("give two accounts on one IP their own budgets", async () => {
    const ip = freshIp();
    expect(await statuses(4, () => asPerson(m.coach.id, ip))).toEqual([200, 200, 200, 200]);
    expect((await asPerson(m.registrar.id, ip)).statusCode).toBe(200);
  });

  it("share one budget for one account on two IPs", async () => {
    const [first, second] = [freshIp(), freshIp()];
    expect(await statuses(2, () => asPerson(m.relative.id, first))).toEqual([200, 200]);
    expect(await statuses(3, () => asPerson(m.relative.id, second))).toEqual([200, 200, 429]);
  });

  it("are stopped by the per-IP backstop across accounts", async () => {
    const ip = freshIp();
    const people = [m.manager.id, m.owner.id, m.parent.id];
    const results: number[] = [];
    for (const personId of people) {
      results.push(...(await statuses(4, () => asPerson(personId, ip))));
    }
    // 10 allowed from the address in total, although each account has 4 left.
    expect(results.filter((status) => status === 200)).toHaveLength(10);
    expect(results.slice(10)).toEqual([429, 429]);
  });
});

describe("bulk reads", () => {
  it("are also limited per club", async () => {
    // Accounts here have used up their own budgets in the tests above.
    const fresh = await createTestApp(
      { ...baseEnv(t, VALKEY_URL), ...limits, RATE_LIMIT_ACCOUNT_MAX: "1000" },
      [],
    );
    const get = (personId: string, url: string) => asPerson(personId, freshIp(), url, fresh);
    try {
      const url = `/api/v1/groups/${m.team.id}/members`;
      // Different accounts and addresses, one club: 3 roster reads in total.
      expect((await get(m.manager.id, url)).statusCode).toBe(200);
      expect((await get(m.coach.id, url)).statusCode).toBe(200);
      expect((await get(m.registrar.id, url)).statusCode).toBe(200);
      expect((await get(m.owner.id, url)).statusCode).toBe(429);
      // Other endpoints of the club are not bulk reads.
      expect((await get(m.member.id, `/api/v1/groups/${m.team.id}`)).statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
  });
});

describe("first-login provisioning", () => {
  const firstLogin = async (target: TestApp, ip: string) => {
    const tokens = await issuer.issue({
      sub: uuidv7(),
      email: `p-${uuidv7().slice(-12)}@example.test`,
      givenName: "Test",
      familyName: "Person",
    });
    return inject(target, {
      method: "GET",
      url: "/api/v1/me",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${tokens.accessToken}`, [ID_TOKEN_HEADER]: tokens.idToken },
    });
  };

  it("allows 10 new accounts per IP and minute across API instances", async () => {
    const generous = { RATE_LIMIT_ACCOUNT_MAX: "1000", RATE_LIMIT_IP_BACKSTOP: "1000" };
    const one = await createTestApp({ ...baseEnv(t, VALKEY_URL), ...generous }, []);
    const two = await createTestApp({ ...baseEnv(t, VALKEY_URL), ...generous }, []);
    try {
      const ip = freshIp();
      const results: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        results.push((await firstLogin(i % 2 === 0 ? one : two, ip)).statusCode);
      }
      expect(results.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
      expect(results[10]).toBe(429);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it("fails closed when Valkey is unreachable, while other requests still work", async () => {
    // Nothing listens on port 1.
    const down = await createTestApp(baseEnv(t, "redis://127.0.0.1:1"), []);
    try {
      const refused = await firstLogin(down, freshIp());
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({
        type: expect.stringMatching(/#unavailable$/) as unknown,
      });
      expect((await asPerson(m.member.id, freshIp(), "/api/v1/me", down)).statusCode).toBe(200);
    } finally {
      await down.close();
    }
  });
});
