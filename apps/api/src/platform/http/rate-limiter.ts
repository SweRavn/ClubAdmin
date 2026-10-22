// SPDX-License-Identifier: AGPL-3.0-only
// Fixed-window counters for the rate limits that need the caller's identity
// (per account, per club; docs/security.md). Counters live in Valkey so all
// API instances share them; without Valkey (tests, a single instance) they
// are kept in memory. Keys contain IDs or IP addresses only.

import type { Redis } from "ioredis";

import { ProblemError } from "./problem-error.ts";

export interface RateLimitRule {
  /** Counter name, e.g. "account" (part of the key). */
  name: string;
  max: number;
  windowMs: number;
  /**
   * When Valkey is configured but unreachable: false lets the request
   * through (most limits), true refuses it with 503 (account creation).
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

const KEY_PREFIX = "clubadmin:ratelimit:";
const MEMORY_MAX_KEYS = 100_000;

export class RateLimiter {
  private readonly store: Redis | undefined;
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(store: Redis | undefined) {
    this.store = store;
  }

  /** Counts one request against `rule` for `subject`. */
  async hit(rule: RateLimitRule, subject: string): Promise<RateLimitResult> {
    const key = `${KEY_PREFIX}${rule.name}:${subject}`;
    if (!this.store) return this.hitMemory(key, rule);
    try {
      const results = await this.store
        .multi()
        .incr(key)
        .pexpire(key, rule.windowMs, "NX")
        .pttl(key)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? rule.windowMs);
      return {
        allowed: count <= rule.max,
        retryAfter: Math.max(1, Math.ceil((ttl > 0 ? ttl : rule.windowMs) / 1000)),
      };
    } catch (error) {
      if (rule.failClosed) throw new ProblemError("unavailable", { cause: error });
      return { allowed: true, retryAfter: 0 };
    }
  }

  /** Like hit, but throws 429 problem details (with Retry-After) when over the limit. */
  async enforce(rule: RateLimitRule, subject: string): Promise<void> {
    const result = await this.hit(rule, subject);
    if (!result.allowed) {
      throw new ProblemError("rate-limited", { retryAfter: result.retryAfter });
    }
  }

  private hitMemory(key: string, rule: RateLimitRule): RateLimitResult {
    const now = Date.now();
    let entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.memory.size >= MEMORY_MAX_KEYS) this.sweep(now);
      entry = { count: 0, resetAt: now + rule.windowMs };
      this.memory.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= rule.max,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  /** Drops expired windows; if that is not enough, the oldest entries. */
  private sweep(now: number): void {
    for (const [key, entry] of this.memory) if (entry.resetAt <= now) this.memory.delete(key);
    for (const key of this.memory.keys()) {
      if (this.memory.size < MEMORY_MAX_KEYS) break;
      this.memory.delete(key);
    }
  }
}
