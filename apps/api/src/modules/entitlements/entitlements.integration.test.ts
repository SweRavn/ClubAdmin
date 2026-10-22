// SPDX-License-Identifier: AGPL-3.0-only
// Entitlements with billing off and on, the club access state, and the
// billing routes (P0.12, docs/hosting-and-billing.md).

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { ClubParamsSchema, type EntitlementsResponse, z } from "@clubadmin/shared";
import { Controller, Module } from "@nestjs/common";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { buildMatrixScenario, type MatrixScenario } from "../../testing/scenarios.ts";
import { createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";
import { RequiresEntitlement } from "./requires-entitlement.decorator.ts";

/** Sample endpoints: a streaming write, a plain write and an export. */
@Controller("test-entitlements/clubs/:clubId")
class SampleController {
  @Endpoint({
    method: "POST",
    path: "streams",
    summary: "Start a stream (needs streaming)",
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: z.object({ ok: z.boolean() }),
    status: 200,
  })
  @RequiresEntitlement("streaming")
  stream(): { ok: boolean } {
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "notes",
    summary: "A change without entitlement",
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: z.object({ ok: z.boolean() }),
    status: 200,
  })
  note(): { ok: boolean } {
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "export",
    summary: "An export",
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: z.object({ ok: z.boolean() }),
    status: 200,
    clubAccess: "export",
  })
  export(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [SampleController] })
class SampleModule {}

let t: TestDatabase;
let m: MatrixScenario;

const env = (t: TestDatabase, extra: Record<string, string> = {}) => ({
  NODE_ENV: "development",
  DATABASE_URL: t.url("app"),
  DEV_AUTH: "true",
  DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
  ...NO_RATE_LIMITS,
  ...extra,
});

beforeAll(async () => {
  t = await createTestDatabase();
  m = await buildMatrixScenario(createCoreServices(t.db), t);
  // Plans: free (no streaming, 50 members), pro (streaming), extra members as an add-on.
  await t.query(
    "admin",
    `WITH p AS (
       INSERT INTO billing.plans (key, name, kind, currency, price_minor) VALUES
         ('free', 'Free', 'base', 'SEK', 0),
         ('pro', 'Pro', 'base', 'SEK', 49900),
         ('more_members', 'More members', 'add_on', 'SEK', 9900)
       RETURNING id, key)
     INSERT INTO billing.plan_entitlements (plan_id, key, kind, enabled, limit_value)
     SELECT p.id, e.key, e.kind, e.enabled, e.limit_value FROM p JOIN (VALUES
       ('free', 'chat', 'feature', true, NULL::bigint),
       ('free', 'members_max', 'limit', NULL::boolean, 50),
       ('pro', 'chat', 'feature', true, NULL),
       ('pro', 'streaming', 'feature', true, NULL),
       ('pro', 'members_max', 'limit', NULL, 500),
       ('more_members', 'members_max', 'limit', NULL, 2000)
     ) AS e(plan, key, kind, enabled, limit_value) ON e.plan = p.key`,
  );
});
afterAll(async () => {
  await t?.drop();
});

async function request(
  app: TestApp,
  personId: string,
  options: Omit<InjectOptions, "headers"> & { mfa?: boolean },
) {
  const token = await devToken(personId, { mfa: options.mfa ?? false });
  const { mfa: _mfa, ...rest } = options;
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({ ...rest, headers: { authorization: `Bearer ${token}` } });
}

const sample = (app: TestApp, path: string, personId = m.manager.id) =>
  request(app, personId, {
    method: "POST",
    url: `/api/v1/test-entitlements/clubs/${m.clubA.id}/${path}`,
  });

const entitlements = async (app: TestApp) =>
  (
    await request(app, m.member.id, {
      method: "GET",
      url: `/api/v1/clubs/${m.clubA.id}/entitlements`,
    })
  ).json<EntitlementsResponse>();

const setAccessState = (app: TestApp, accessState: string) =>
  request(app, m.operator.id, {
    method: "PUT",
    url: `/api/v1/clubs/${m.clubA.id}/access-state`,
    payload: { accessState },
    mfa: true,
  });

describe("billing off (self-hosted)", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp(env(t, { BILLING_ENABLED: "false" }), [SampleModule]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("grants every enabled feature without limits, and has no billing routes", async () => {
    const body = await entitlements(app);
    expect(body).toMatchObject({
      billingEnabled: false,
      plan: null,
      accessState: "active",
      features: { chat: true, streaming: true, finance: true },
      limits: { members_max: null, storage_gb: null },
    });
    expect((await sample(app, "streams")).statusCode).toBe(200);
    const plans = await request(app, m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/plans",
      mfa: true,
    });
    expect(plans.statusCode).toBe(404);
  });

  it("treats a feature switched off for the installation as not found", async () => {
    const off = await createTestApp(
      env(t, { BILLING_ENABLED: "false", FEATURE_STREAMING: "false" }),
      [SampleModule],
    );
    try {
      const res = await sample(off, "streams");
      expect(res.statusCode).toBe(404);
      expect((await entitlements(off)).features.streaming).toBe(false);
    } finally {
      await off.close();
    }
  });

  it("lets only operators change the access state; read-only refuses changes but not reads or exports", async () => {
    const byManager = await request(app, m.manager.id, {
      method: "PUT",
      url: `/api/v1/clubs/${m.clubA.id}/access-state`,
      payload: { accessState: "read_only" },
      mfa: true,
    });
    expect(byManager.statusCode).toBe(403);

    expect((await setAccessState(app, "read_only")).statusCode).toBe(200);
    try {
      const write = await sample(app, "notes");
      expect(write.statusCode).toBe(409);
      expect(write.json()).toMatchObject({
        type: expect.stringMatching(/#club-read-only$/) as unknown,
      });
      const read = await request(app, m.member.id, {
        method: "GET",
        url: `/api/v1/clubs/${m.clubA.id}`,
      });
      expect(read.statusCode).toBe(200);
      expect((await sample(app, "export")).statusCode).toBe(200);
      expect((await entitlements(app)).accessState).toBe("read_only");

      expect((await setAccessState(app, "suspended")).statusCode).toBe(200);
      const suspendedRead = await request(app, m.member.id, {
        method: "GET",
        url: `/api/v1/clubs/${m.clubA.id}`,
      });
      expect(suspendedRead.statusCode).toBe(409);
      expect(suspendedRead.json()).toMatchObject({
        type: expect.stringMatching(/#club-suspended$/) as unknown,
      });
      expect((await sample(app, "export")).statusCode).toBe(200);
    } finally {
      expect((await setAccessState(app, "active")).statusCode).toBe(200);
    }
    expect((await sample(app, "notes")).statusCode).toBe(200);
    const audit = await t.query<{ action: string; actor_kind: string }>(
      "admin",
      "SELECT action, actor_kind FROM audit.events WHERE resource_id = $1 AND action = 'club.access_state.changed'",
      [m.clubA.id],
    );
    expect(audit.rows.length).toBe(3);
    expect(audit.rows.every((r) => r.actor_kind === "operator")).toBe(true);
  });
});

describe("billing on (hosted)", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp(env(t, { BILLING_ENABLED: "true", BILLING_DEFAULT_PLAN: "free" }), [
      SampleModule,
    ]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const assign = (planKey: string, addOns: string[] = []) =>
    request(app, m.operator.id, {
      method: "PUT",
      url: `/api/v1/clubs/${m.clubA.id}/subscription`,
      payload: { planKey, addOns },
      mfa: true,
    });
  const setStatus = (status: string) =>
    request(app, m.operator.id, {
      method: "PUT",
      url: `/api/v1/clubs/${m.clubA.id}/subscription/status`,
      payload: { status },
      mfa: true,
    });

  it("uses the default plan without a subscription, and blocks what it does not include", async () => {
    expect(await entitlements(app)).toMatchObject({
      billingEnabled: true,
      plan: { key: "free", name: "Free" },
      subscriptionStatus: null,
      features: { chat: true, streaming: false },
      limits: { members_max: 50, storage_gb: null },
    });
    const res = await sample(app, "streams");
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      type: expect.stringMatching(/#entitlement-required$/) as unknown,
      detail: "streaming",
    });
  });

  it("applies a plan change from the next request", async () => {
    const assigned = await assign("pro", ["more_members"]);
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      subscription: { planKey: "pro", addOns: ["more_members"], status: "active" },
    });
    expect((await sample(app, "streams")).statusCode).toBe(200);
    expect((await entitlements(app)).limits.members_max).toBe(2000);

    expect((await assign("free")).statusCode).toBe(200);
    expect((await sample(app, "streams")).statusCode).toBe(402);
    expect((await assign("unknown")).statusCode).toBe(404);
  });

  it("makes the club read-only when the subscription is, and back", async () => {
    expect((await setStatus("past_due")).statusCode).toBe(200);
    expect((await setStatus("read_only")).statusCode).toBe(200);
    expect((await sample(app, "notes")).statusCode).toBe(409);
    expect((await sample(app, "export")).statusCode).toBe(200);
    expect(await entitlements(app)).toMatchObject({
      accessState: "read_only",
      subscriptionStatus: "read_only",
    });
    // Not every move is allowed.
    expect((await setStatus("past_due")).statusCode).toBe(409);
    expect((await setStatus("active")).statusCode).toBe(200);
    expect((await sample(app, "notes")).statusCode).toBe(200);
  });

  it("shows the subscription to club managers, not to members; plans to operators", async () => {
    const manager = await request(app, m.manager.id, {
      method: "GET",
      url: `/api/v1/clubs/${m.clubA.id}/subscription`,
    });
    expect(manager.statusCode).toBe(200);
    expect(manager.json()).toMatchObject({ subscription: { planKey: "free", status: "active" } });
    const member = await request(app, m.member.id, {
      method: "GET",
      url: `/api/v1/clubs/${m.clubA.id}/subscription`,
    });
    expect(member.statusCode).toBe(403);
    const plans = await request(app, m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/plans",
      mfa: true,
    });
    expect(plans.statusCode).toBe(200);
    expect(plans.json<{ plans: { key: string }[] }>().plans.map((p) => p.key)).toEqual(
      expect.arrayContaining(["free", "pro", "more_members"]),
    );
    const audit = await t.query<{ action: string }>(
      "admin",
      "SELECT DISTINCT action FROM audit.events WHERE action LIKE 'billing.%' ORDER BY action",
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "billing.subscription.created",
      "billing.subscription.plan.changed",
      "billing.subscription.status.changed",
    ]);
  });
});
