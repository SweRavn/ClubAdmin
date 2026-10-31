// SPDX-License-Identifier: AGPL-3.0-only
// Identity end to end through the HTTP API: token validation, first-login
// provisioning, email sync, own-login invitations, MFA step-up, sessions and
// DEV_AUTH. The identity provider is a fake issuer (testing/oidc.ts).

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import {
  ACCOUNT_INVITATION_HEADER,
  CLIENT_DEVICE_HEADER,
  CLIENT_PLATFORM_HEADER,
  CLIENT_VERSION_HEADER,
  ID_TOKEN_HEADER,
  personSessionsKey,
  sessionKey,
  uuidv7,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actor, buildFamily, buildPerson } from "../../testing/builders.ts";
import {
  devToken,
  type FakeIssuer,
  type IssuedTokens,
  startFakeIssuer,
  TEST_AUDIENCE,
  TEST_DEV_AUTH_KEY,
  TEST_MOBILE_CLIENT,
} from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let issuer: FakeIssuer;
let app: TestApp;
let valkey: Redis;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  issuer = await startFakeIssuer();
  valkey = new Redis(process.env.VALKEY_URL ?? "redis://127.0.0.1:6379", { lazyConnect: true });
  await valkey.connect();
  app = await createTestApp(
    {
      NODE_ENV: "development",
      ...NO_RATE_LIMITS,
      DATABASE_URL: t.url("app"),
      VALKEY_URL: process.env.VALKEY_URL ?? "redis://127.0.0.1:6379",
      AUTH_ISSUER: issuer.issuer,
      AUTH_AUDIENCE: TEST_AUDIENCE,
      AUTH_JWKS_URL: issuer.jwksUrl,
      AUTH_MOBILE_CLIENT_ID: TEST_MOBILE_CLIENT,
      ZITADEL_API_URL: issuer.issuer,
      ZITADEL_API_TOKEN: "test-token",
      DEV_AUTH: "true",
      DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
      NOTIFICATION_TOKEN_KEY: "notification-token-key-for-tests-0123456789",
      PUSH_PROVIDER: "fake",
    },
    [],
  );
});
afterAll(async () => {
  await app?.close();
  valkey?.disconnect();
  await issuer?.close();
  await t?.drop();
});

const inject = (options: InjectOptions) => app.app.getHttpAdapter().getInstance().inject(options);
const withTokens = (tokens: IssuedTokens, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${tokens.accessToken}`,
  [ID_TOKEN_HEADER]: tokens.idToken,
  ...extra,
});
const accountsOf = async (email: string) =>
  (
    await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM accounts WHERE lower(email) = lower($1)",
      [email],
    )
  ).rows[0]!.n;

describe("authentication", () => {
  it("refuses requests without or with an invalid token", async () => {
    expect((await inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    const res = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining("#unauthenticated") as unknown,
    });
  });

  it("creates account and person on the first login, once", async () => {
    const email = `new-${uuidv7().slice(-8)}@example.test`;
    const tokens = await issuer.issue({
      sub: uuidv7(),
      email,
      givenName: "Emma",
      familyName: "Svensson",
    });
    const first = await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) });
    expect(first.statusCode).toBe(200);
    const me = first.json<{
      personId: string;
      accountId: string;
      person: { displayName: string };
    }>();
    expect(me.person.displayName).toBe("Emma Svensson");

    const again = await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) });
    expect(again.json()).toMatchObject({ personId: me.personId, accountId: me.accountId });
    // Later requests do not need the ID token.
    const accessOnly = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(accessOnly.json()).toMatchObject({ personId: me.personId });
    expect(await accountsOf(email)).toBe(1);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM people WHERE id = $1",
      [me.personId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("reads and changes the account preferences", async () => {
    // Built with an account (the login flow's provisioning is rate limited per IP).
    const person = await buildPerson(s);
    const headers = { authorization: `Bearer ${await devToken(person.id)}` };
    const me = await inject({ method: "GET", url: "/api/v1/me", headers });
    expect(me.json()).toMatchObject({
      preferences: { locale: null, timeZone: null, theme: null },
    });
    const patch = (payload: Record<string, unknown>) =>
      inject({ method: "PATCH", url: "/api/v1/me/preferences", headers, payload });
    const changed = await patch({ locale: "nb", timeZone: "Europe/Oslo" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ locale: "nb", timeZone: "Europe/Oslo", theme: null });
    expect((await patch({ locale: null })).json()).toMatchObject({ locale: null });
    expect((await patch({ timeZone: "Mars/Olympus" })).statusCode).toBe(400);
    expect((await patch({ locale: "de" })).statusCode).toBe(400);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM audit.events WHERE actor_person_id = $1 AND action = 'account.preferences.updated'",
      [person.id],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("needs the verified email of the ID token to create an account", async () => {
    const tokens = await issuer.issue({
      sub: uuidv7(),
      email: "unverified@example.test",
      emailVerified: false,
    });
    const res = await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ detail: "verified_email_required" });
    const accessOnly = await issuer.issue({ sub: uuidv7(), email: "x@example.test" });
    const noId = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${accessOnly.accessToken}` },
    });
    expect(noId.statusCode).toBe(401);
  });

  it("refuses an email that differs only in case from an existing account (no merge by email)", async () => {
    const email = `case-${uuidv7().slice(-8)}@example.test`;
    await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub: uuidv7(), email })),
    });
    const res = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub: uuidv7(), email: email.toUpperCase() })),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ detail: "email_taken" });
    expect(JSON.stringify(res.json())).not.toContain(email.slice(0, 8));
    expect(await accountsOf(email)).toBe(1);
  });

  it("takes over an email changed in the identity provider on the next login", async () => {
    const sub = uuidv7();
    const before = `before-${uuidv7().slice(-8)}@example.test`;
    const after = `after-${uuidv7().slice(-8)}@example.test`;
    await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub, email: before })),
    });
    const res = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub, email: after })),
    });
    expect(res.statusCode).toBe(200);
    expect(await accountsOf(after)).toBe(1);
    expect(await accountsOf(before)).toBe(0);
  });

  it("links a 'give own login' sign-up to the invited person", async () => {
    const family = await buildFamily(s, { childBirthDate: "2010-01-01" });
    const email = `oskar-${uuidv7().slice(-8)}@example.test`;
    const { token } = await s.accounts.createOwnLoginInvitation(
      actor(family.guardian.id),
      family.child.id,
      email,
    );
    const wrongEmail = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub: uuidv7(), email: `other-${email}` }), {
        [ACCOUNT_INVITATION_HEADER]: token,
      }),
    });
    expect(wrongEmail.statusCode).toBe(409);
    expect(wrongEmail.json()).toMatchObject({ detail: "invitation_invalid" });

    const res = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub: uuidv7(), email }), {
        [ACCOUNT_INVITATION_HEADER]: token,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ personId: family.child.id });
    // The token works once.
    const reuse = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(await issuer.issue({ sub: uuidv7(), email: `x-${email}` }), {
        [ACCOUNT_INVITATION_HEADER]: token,
      }),
    });
    expect(reuse.json()).toMatchObject({ detail: "invitation_invalid" });
  });

  it("@RequireMfa answers mfa-required without a second factor", async () => {
    const sub = uuidv7();
    const email = `mfa-${uuidv7().slice(-8)}@example.test`;
    const pwd = await inject({
      method: "GET",
      url: "/api/v1/me/security",
      headers: withTokens(await issuer.issue({ sub, email, amr: ["pwd"] })),
    });
    expect(pwd.statusCode).toBe(403);
    expect(pwd.json()).toMatchObject({
      type: expect.stringContaining("#mfa-required") as unknown,
      detail: "mfa_required",
    });
    const mfa = await inject({
      method: "GET",
      url: "/api/v1/me/security",
      headers: withTokens(await issuer.issue({ sub, email, amr: ["pwd", "otp", "mfa"] })),
    });
    expect(mfa.statusCode).toBe(200);
    expect(mfa.json()).toMatchObject({ mfa: true });
  });
});

describe("sessions", () => {
  it("lists and revokes the person's own sessions, ending the Zitadel session", async () => {
    const sub = uuidv7();
    const tokens = await issuer.issue({
      sub,
      email: `s-${uuidv7().slice(-8)}@example.test`,
      sid: "zitadel-current",
    });
    const me = (
      await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) })
    ).json<{
      personId: string;
    }>();
    const now = new Date().toISOString();
    const meta = (id: string, idp: string) =>
      JSON.stringify({
        id,
        storageId: `secret-${id}`,
        createdAt: now,
        lastSeenAt: now,
        device: "Firefox on Linux",
        idpSessionId: idp,
        devAuth: false,
      });
    await valkey.hset(
      personSessionsKey(me.personId),
      "bff-1",
      meta("bff-1", "zitadel-current"),
      "bff-2",
      meta("bff-2", "zitadel-other"),
    );
    await valkey.set(sessionKey("secret-bff-2"), "encrypted");

    const list = await inject({
      method: "GET",
      url: "/api/v1/me/sessions",
      headers: withTokens(tokens),
    });
    expect(list.body).not.toContain("secret-");
    expect(
      list
        .json<{ sessions: { id: string; current: boolean }[] }>()
        .sessions.map((x) => [x.id, x.current])
        .sort(),
    ).toEqual([
      ["bff-1", true],
      ["bff-2", false],
    ]);

    const revoke = await inject({
      method: "DELETE",
      url: "/api/v1/me/sessions/bff-2",
      headers: withTokens(tokens),
    });
    expect(revoke.statusCode).toBe(204);
    expect(await valkey.exists(sessionKey("secret-bff-2"))).toBe(0);
    expect(issuer.deletedSessions).toContain("zitadel-other");
    const missing = await inject({
      method: "DELETE",
      url: "/api/v1/me/sessions/bff-2",
      headers: withTokens(tokens),
    });
    expect(missing.statusCode).toBe(404);

    // Someone else cannot revoke it.
    const other = await issuer.issue({
      sub: uuidv7(),
      email: `o-${uuidv7().slice(-8)}@example.test`,
    });
    const foreign = await inject({
      method: "DELETE",
      url: "/api/v1/me/sessions/bff-1",
      headers: withTokens(other),
    });
    expect(foreign.statusCode).toBe(404);
    await valkey.del(personSessionsKey(me.personId));
  });

  it("lists the mobile app's sessions, and revoking one ends the Zitadel session for good", async () => {
    const sid = `zitadel-mobile-${uuidv7()}`;
    const tokensSub = uuidv7();
    const tokensEmail = `m-${uuidv7().slice(-8)}@example.test`;
    const tokens = await issuer.issue({
      sub: tokensSub,
      email: tokensEmail,
      sid,
      clientId: TEST_MOBILE_CLIENT,
    });
    const app = {
      [CLIENT_PLATFORM_HEADER]: "android",
      [CLIENT_VERSION_HEADER]: "1.2.0",
      [CLIENT_DEVICE_HEADER]: "Pixel 8 (Android 16)<script>",
    };
    const sessions = async () => {
      // Registration happens after the response; wait for it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return (
        await inject({
          method: "GET",
          url: "/api/v1/me/sessions",
          headers: withTokens(tokens, app),
        })
      ).json<{
        sessions: {
          id: string;
          client: string;
          device: string;
          current: boolean;
          devAuth: boolean;
        }[];
      }>().sessions;
    };
    const listed = await sessions();
    expect(listed).toHaveLength(1);
    const personId = (
      await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) })
    ).json<{ personId: string }>().personId;
    expect(listed[0]).toMatchObject({
      client: "mobile",
      device: "Pixel 8 (Android 16)script, app 1.2.0",
      current: true,
      devAuth: false,
    });

    const handle = listed[0]!.id;
    expect(handle).not.toContain(sid);
    // The phone registered for push in this session (P1.7).
    const device = await inject({
      method: "PUT",
      url: "/api/v1/me/push-devices",
      headers: withTokens(tokens, app),
      payload: { token: `ExponentPushToken[${uuidv7()}]`, platform: "android" },
    });
    expect(device.statusCode).toBe(200);
    const deviceId = device.json<{ id: string }>().id;
    const revoke = await inject({
      method: "DELETE",
      url: `/api/v1/me/sessions/${handle}`,
      headers: withTokens(tokens),
    });
    expect(revoke.statusCode).toBe(204);
    expect(issuer.deletedSessions).toContain(sid);
    // Its phone gets no more push notifications.
    const { rows: devices } = await t.query("admin", "SELECT 1 FROM push_devices WHERE id = $1", [
      deviceId,
    ]);
    expect(devices).toEqual([]);
    const { rows: removed } = await t.query(
      "admin",
      "SELECT 1 FROM audit.events WHERE action = 'push_device.removed' AND resource_id = $1",
      [deviceId],
    );
    expect(removed).toHaveLength(1);
    // Zitadel may still refresh the app's tokens, so the API refuses the whole
    // session from now on (deny list), and it is not registered again.
    const refused = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withTokens(tokens, app),
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ detail: "session_revoked" });
    const refreshed = await issuer.issue({
      sub: tokensSub,
      email: tokensEmail,
      sid,
      clientId: TEST_MOBILE_CLIENT,
    });
    expect(
      (await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(refreshed, app) }))
        .statusCode,
    ).toBe(401);
    // Public endpoints treat the tokens as anonymous.
    expect(
      (await inject({ method: "GET", url: "/api/v1/meta/client", headers: withTokens(tokens) }))
        .statusCode,
    ).toBe(200);
    expect(await valkey.hlen(personSessionsKey(personId))).toBe(0);
  });

  it("does not list web or unknown clients as mobile sessions", async () => {
    const tokens = await issuer.issue({
      sub: uuidv7(),
      email: `w-${uuidv7().slice(-8)}@example.test`,
    });
    await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const list = await inject({
      method: "GET",
      url: "/api/v1/me/sessions",
      headers: withTokens(tokens),
    });
    expect(list.json()).toEqual({ sessions: [] });
  });
});

describe("DEV_AUTH", () => {
  it("issues development tokens for the mobile app, listed as a development session", async () => {
    const person = await buildPerson(s);
    const res = await inject({
      method: "POST",
      url: "/api/v1/dev/tokens",
      payload: { personId: person.id, mfa: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      accessToken: string;
      idToken: null;
      expiresAt: string;
      sessionId: string;
    }>();
    expect(body.idToken).toBeNull();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const headers = {
      authorization: `Bearer ${body.accessToken}`,
      [CLIENT_PLATFORM_HEADER]: "ios",
    };
    const me = await inject({ method: "GET", url: "/api/v1/me", headers });
    expect(me.json()).toMatchObject({ personId: person.id, mfa: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const list = await inject({ method: "GET", url: "/api/v1/me/sessions", headers });
    expect(list.json<{ sessions: unknown[] }>().sessions).toEqual([
      expect.objectContaining({ client: "mobile", devAuth: true, device: "iOS", current: true }),
    ]);
    // A development session is not a Zitadel session: revoking does not call Zitadel.
    const id = list.json<{ sessions: { id: string }[] }>().sessions[0]!.id;
    const before = issuer.deletedSessions.length;
    await inject({ method: "DELETE", url: `/api/v1/me/sessions/${id}`, headers });
    expect(issuer.deletedSessions).toHaveLength(before);
  });

  it("refuses development tokens for invalid input", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/v1/dev/tokens",
      payload: { personId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("logs in as any person with a development token; MFA can be toggled", async () => {
    const family = await buildFamily(s);
    const child = await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${await devToken(family.child.id)}` },
    });
    expect(child.statusCode).toBe(200);
    expect(child.json()).toMatchObject({ personId: family.child.id, accountId: null, mfa: false });
    const guardian = await inject({
      method: "GET",
      url: "/api/v1/me/security",
      headers: { authorization: `Bearer ${await devToken(family.guardian.id, { mfa: true })}` },
    });
    expect(guardian.statusCode).toBe(200);
  });

  it("lists personas with their clubs and roles", async () => {
    const res = await inject({ method: "GET", url: "/api/v1/dev/personas" });
    expect(res.statusCode).toBe(200);
    const { personas } = res.json<{
      personas: { person: { id: string }; hasAccount: boolean }[];
    }>();
    expect(personas.length).toBeGreaterThan(0);
    expect(personas.every((p) => p.hasAccount)).toBe(true);
  });

  it("is off without DEV_AUTH: no persona route, development tokens refused", async () => {
    const off = await createTestApp(
      { DATABASE_URL: t.url("app"), AUTH_ISSUER: issuer.issuer, AUTH_AUDIENCE: TEST_AUDIENCE },
      [],
    );
    try {
      const inj = (o: InjectOptions) => off.app.getHttpAdapter().getInstance().inject(o);
      expect((await inj({ method: "GET", url: "/api/v1/dev/personas" })).statusCode).toBe(404);
      const tokens = await inj({
        method: "POST",
        url: "/api/v1/dev/tokens",
        payload: { personId: uuidv7() },
      });
      expect(tokens.statusCode).toBe(404);
      const family = await buildFamily(s);
      const res = await inj({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${await devToken(family.guardian.id)}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await off.close();
    }
  });

  it("logs a warning at every start when enabled", () => {
    expect(app.rawLogs()).toContain("DEV_AUTH is enabled");
  });
});

describe("token contents are never logged", () => {
  it("keeps tokens out of the logs", async () => {
    const tokens = await issuer.issue({
      sub: uuidv7(),
      email: `log-${uuidv7().slice(-8)}@example.test`,
    });
    await inject({ method: "GET", url: "/api/v1/me", headers: withTokens(tokens) });
    await inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}x` },
    });
    const logs = app.rawLogs();
    expect(logs).not.toContain(tokens.accessToken.split(".")[1]);
    expect(logs).not.toContain(tokens.idToken.split(".")[1]);
  });
});
