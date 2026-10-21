// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyBase64 } from "@clubadmin/server-kit/crypto";
import { personSessionsKey, sessionKey } from "@clubadmin/shared";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { parseWebConfig } from "./config.ts";
import { checkCsrf } from "./csrf.ts";
import { describeDevice } from "./device.ts";
import { safeReturnTo } from "./return-to.ts";
import { type SessionRecord, SessionStore } from "./session-store.ts";

describe("safeReturnTo", () => {
  it.each([
    ["/me", "/me"],
    ["/groups/1?tab=members#top", "/groups/1?tab=members#top"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
    ["/me\nSet-Cookie: x", "/"],
    [null, "/"],
  ])("%s → %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe("checkCsrf", () => {
  const base = {
    method: "POST",
    origin: "https://clubadmin.localhost",
    expectedOrigin: "https://clubadmin.localhost",
    submitted: "token",
    cookie: "token",
    session: "token",
  };
  it("passes safe methods and matching tokens", () => {
    expect(checkCsrf({ ...base, method: "GET", submitted: null })).toBe(true);
    expect(checkCsrf(base)).toBe(true);
    expect(checkCsrf({ ...base, origin: null })).toBe(true);
  });
  it("refuses missing or mismatching tokens and other origins", () => {
    expect(checkCsrf({ ...base, submitted: null })).toBe(false);
    expect(checkCsrf({ ...base, submitted: "other" })).toBe(false);
    expect(checkCsrf({ ...base, session: "other" })).toBe(false);
    expect(checkCsrf({ ...base, origin: "https://evil.example" })).toBe(false);
  });
});

describe("describeDevice", () => {
  it("summarises the User-Agent", () => {
    expect(
      describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"),
    ).toBe("Firefox on Linux");
    expect(describeDevice(null)).toBe("Unknown device");
  });
});

describe("web configuration", () => {
  it("refuses DEV_AUTH outside development (startup guard)", () => {
    const key = "k".repeat(32);
    expect(
      parseWebConfig({ NODE_ENV: "development", DEV_AUTH: "true", DEV_AUTH_KEY: key }).DEV_AUTH,
    ).toBe(true);
    expect(() =>
      parseWebConfig({
        NODE_ENV: "production",
        DEV_AUTH: "true",
        DEV_AUTH_KEY: key,
        SESSION_ENCRYPTION_KEY: "x",
      }),
    ).toThrow(/DEV_AUTH/);
    expect(() =>
      parseWebConfig({
        NODE_ENV: "development",
        DEPLOYMENT_MODE: "hosted",
        DEV_AUTH: "true",
        DEV_AUTH_KEY: key,
      }),
    ).toThrow(/DEV_AUTH/);
  });
  it("needs a session encryption key in production", () => {
    expect(() => parseWebConfig({ NODE_ENV: "production" })).toThrow(/SESSION_ENCRYPTION_KEY/);
  });
});

/** In-memory stand-in for the few Valkey commands the store uses. */
function fakeValkey() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const done = <T>(value: T) => Promise.resolve(value);
  const commands = {
    set: (key: string, value: string) => (strings.set(key, value), commands),
    del: (key: string) => (strings.delete(key), commands),
    hset: (key: string, field: string, value: string) => {
      hashes.set(key, (hashes.get(key) ?? new Map<string, string>()).set(field, value));
      return commands;
    },
    hdel: (key: string, field: string) => (hashes.get(key)?.delete(field), commands),
    expire: () => commands,
    exec: () => done([]),
  };
  return {
    strings,
    hashes,
    client: {
      multi: () => commands,
      get: (key: string) => done(strings.get(key) ?? null),
      set: (key: string, value: string) => done((strings.set(key, value), "OK")),
    } as unknown as Redis,
  };
}

describe("SessionStore", () => {
  const record: SessionRecord = {
    personId: "01a15c90-0000-7000-8000-000000000001",
    handle: "public-handle",
    accessToken: "eyJ.access.token",
    idToken: "eyJ.id.token",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60_000,
    idpSessionId: "zitadel-session",
    csrf: "csrf",
    devAuth: false,
    createdAt: new Date().toISOString(),
    device: "Firefox on Linux",
  };

  it("stores tokens encrypted and indexes the session by its public handle", async () => {
    const valkey = fakeValkey();
    const key = Buffer.from(generateKeyBase64(), "base64");
    const store = new SessionStore(valkey.client, key);
    const id = await store.create(record);
    const sealed = valkey.strings.get(sessionKey(id))!;
    expect(sealed).not.toContain("refresh-secret");
    expect(sealed).not.toContain("eyJ");
    expect(await store.get(id)).toEqual(record);

    const index = valkey.hashes.get(personSessionsKey(record.personId))!;
    expect([...index.keys()]).toEqual(["public-handle"]);
    expect(JSON.parse(index.get("public-handle")!)).toMatchObject({
      id: "public-handle",
      storageId: id,
    });

    // Another key cannot read it (rotated key or tampering = logged out).
    const other = new SessionStore(valkey.client, Buffer.from(generateKeyBase64(), "base64"));
    expect(await other.get(id)).toBeNull();
  });
});
