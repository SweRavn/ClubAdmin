// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { ProblemError } from "./problem-error.ts";
import { RateLimiter } from "./rate-limiter.ts";

const rule = { name: "test", max: 2, windowMs: 60_000 };

/** A Valkey client whose transactions always fail, as when it is unreachable. */
const unreachable = {
  multi: () => {
    const chain = {
      incr: () => chain,
      pexpire: () => chain,
      pttl: () => chain,
      exec: () => Promise.reject(new Error("Stream isn't writeable")),
    };
    return chain;
  },
} as unknown as Redis;

describe("RateLimiter in memory", () => {
  it("allows max requests per subject and window, then reports when to retry", async () => {
    const limiter = new RateLimiter(undefined);
    expect((await limiter.hit(rule, "a")).allowed).toBe(true);
    expect((await limiter.hit(rule, "a")).allowed).toBe(true);
    const third = await limiter.hit(rule, "a");
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
    expect(third.retryAfter).toBeLessThanOrEqual(60);
    expect((await limiter.hit(rule, "b")).allowed).toBe(true);
    expect((await limiter.hit({ ...rule, name: "other" }, "a")).allowed).toBe(true);
  });

  it("starts a new window when the old one has passed", async () => {
    const limiter = new RateLimiter(undefined);
    const short = { ...rule, max: 1, windowMs: 20 };
    await limiter.hit(short, "a");
    expect((await limiter.hit(short, "a")).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await limiter.hit(short, "a")).allowed).toBe(true);
  });

  it("enforce throws 429 problem details with Retry-After", async () => {
    const limiter = new RateLimiter(undefined);
    await limiter.enforce(rule, "a");
    await limiter.enforce(rule, "a");
    const error = await limiter.enforce(rule, "a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ slug: "rate-limited", status: 429 });
    expect((error as ProblemError).retryAfter).toBeGreaterThan(0);
  });
});

describe("RateLimiter with Valkey unreachable", () => {
  it("lets requests through by default", async () => {
    const limiter = new RateLimiter(unreachable);
    expect((await limiter.hit(rule, "a")).allowed).toBe(true);
  });

  it("refuses with 503 for fail-closed rules", async () => {
    const limiter = new RateLimiter(unreachable);
    await expect(limiter.hit({ ...rule, failClosed: true }, "a")).rejects.toMatchObject({
      slug: "unavailable",
      status: 503,
    });
  });
});
