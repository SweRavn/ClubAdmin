// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import {
  enabledFeatures,
  FlagsEntitlements,
} from "../../platform/entitlements/entitlements.source.ts";
import { type ClubEntitlements, EntitlementsService } from "./entitlements.service.ts";

const CLUB = "0199a000-0000-7000-8001-000000000001";

/** A database answering only the access-state query. */
function fakeDb(accessState = "active") {
  let queries = 0;
  const db = {
    withSystem: (_job: string, _options: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      queries += 1;
      return fn({ execute: () => Promise.resolve({ rows: [{ access_state: accessState }] }) });
    },
  } as unknown as Database;
  return { db, queries: () => queries };
}

function service(options: { flags?: Record<string, unknown>; accessState?: string } = {}) {
  const enabled = enabledFeatures(options.flags ?? {});
  const { db, queries } = fakeDb(options.accessState);
  const entitlements = new EntitlementsService(
    db,
    new FlagsEntitlements(enabled),
    new EntitlementsCache<ClubEntitlements>(undefined),
    { enabled, billingEnabled: false },
  );
  return { entitlements, queries };
}

describe("EntitlementsService", () => {
  it("grants every feature with billing off, except those switched off", async () => {
    const { entitlements } = service({ flags: { FEATURE_STREAMING: false } });
    expect(await entitlements.has(CLUB, "chat")).toBe(true);
    expect(await entitlements.has(CLUB, "streaming")).toBe(false);
    expect(await entitlements.limit(CLUB, "members_max")).toBeNull();
  });

  it("answers from the cache without database queries, in well under 0.1 ms", async () => {
    const { entitlements, queries } = service();
    await entitlements.has(CLUB, "chat");
    const before = queries();
    const runs = 2000;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) await entitlements.has(CLUB, "chat");
    const perCall = (performance.now() - started) / runs;
    expect(queries()).toBe(before);
    expect(perCall).toBeLessThan(0.1);
  });

  it("reloads after an invalidation", async () => {
    const { entitlements, queries } = service();
    await entitlements.snapshot(CLUB);
    await entitlements.invalidate(CLUB);
    await entitlements.snapshot(CLUB);
    expect(queries()).toBe(2);
  });

  it("refuses writes in read-only clubs and everything but exports in suspended ones", async () => {
    const readOnly = service({ accessState: "read_only" }).entitlements;
    const request = { clubId: CLUB, feature: undefined, clubAccess: "default" as const };
    await expect(readOnly.enforce({ ...request, method: "GET" })).resolves.toBeUndefined();
    await expect(readOnly.enforce({ ...request, method: "POST" })).rejects.toMatchObject({
      slug: "club-read-only",
    });
    await expect(
      readOnly.enforce({ ...request, method: "POST", clubAccess: "export" }),
    ).resolves.toBeUndefined();
    const suspended = service({ accessState: "suspended" }).entitlements;
    await expect(suspended.enforce({ ...request, method: "GET" })).rejects.toMatchObject({
      slug: "club-suspended",
    });
    await expect(
      suspended.enforce({ ...request, method: "GET", clubAccess: "exempt" }),
    ).resolves.toBeUndefined();
  });
});

describe("EntitlementsCache", () => {
  it("does not keep a value loaded before an invalidation", async () => {
    const cache = new EntitlementsCache<number>(undefined);
    let release: (value: number) => void = () => undefined;
    const pending = cache.get("c", () => new Promise<number>((resolve) => (release = resolve)));
    await cache.invalidate("c");
    release(1);
    expect(await pending).toBe(1);
    expect(await cache.get("c", () => Promise.resolve(2))).toBe(2);
  });

  it("expires entries after a minute", async () => {
    let now = 0;
    const cache = new EntitlementsCache<number>(undefined, () => now);
    await cache.get("c", () => Promise.resolve(1));
    now = 59_000;
    expect(await cache.get("c", () => Promise.resolve(2))).toBe(1);
    now = 61_000;
    expect(await cache.get("c", () => Promise.resolve(3))).toBe(3);
  });
});
