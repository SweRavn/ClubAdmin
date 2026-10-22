// SPDX-License-Identifier: AGPL-3.0-only
// The rate limits that need the caller's identity (docs/security.md, "Rate
// limits"). The per-IP limits live in app.ts (@fastify/rate-limit): requests
// without a bearer token get RATE_LIMIT_MAX, requests with one a much higher
// backstop. Here: per account, bulk reads per club and per account, rejected
// tokens (counted like unauthenticated requests), and first-login
// provisioning (#7), which fails closed when Valkey is unreachable.

import type { ApiConfig } from "../../config.ts";
import type { RateLimiter, RateLimitRule } from "../../platform/http/rate-limiter.ts";
import type { Principal } from "./principal.ts";

type LimitsConfig = Pick<
  ApiConfig,
  | "RATE_LIMIT_MAX"
  | "RATE_LIMIT_WINDOW_MS"
  | "RATE_LIMIT_ACCOUNT_MAX"
  | "RATE_LIMIT_CLUB_BULK_MAX"
  | "RATE_LIMIT_ACCOUNT_BULK_MAX"
  | "RATE_LIMIT_PROVISIONING_MAX"
>;

/** Rate-limit subject for a principal: the account, or the person for DEV_AUTH children. */
const subjectOf = (principal: Principal) =>
  principal.accountId ? `a:${principal.accountId}` : `p:${principal.personId}`;

export class RequestLimits {
  private readonly limiter: RateLimiter;
  private readonly rules: Record<
    "account" | "clubBulk" | "accountBulk" | "rejectedToken" | "provisioning",
    RateLimitRule
  >;

  constructor(limiter: RateLimiter, config: LimitsConfig) {
    this.limiter = limiter;
    const windowMs = config.RATE_LIMIT_WINDOW_MS;
    this.rules = {
      account: { name: "account", max: config.RATE_LIMIT_ACCOUNT_MAX, windowMs },
      clubBulk: { name: "club-bulk", max: config.RATE_LIMIT_CLUB_BULK_MAX, windowMs },
      accountBulk: { name: "account-bulk", max: config.RATE_LIMIT_ACCOUNT_BULK_MAX, windowMs },
      rejectedToken: { name: "rejected-token", max: config.RATE_LIMIT_MAX, windowMs },
      provisioning: {
        name: "provisioning",
        max: config.RATE_LIMIT_PROVISIONING_MAX,
        windowMs: 60_000,
        failClosed: true,
      },
    };
  }

  /** Every authenticated request; the on-behalf-of ward has no budget of its own. */
  account(principal: Principal): Promise<void> {
    return this.limiter.enforce(this.rules.account, subjectOf(principal));
  }

  /** Endpoints marked bulkRead, after authorization resolved the club. */
  async bulkRead(principal: Principal, clubId: string): Promise<void> {
    await this.limiter.enforce(this.rules.clubBulk, clubId);
    await this.limiter.enforce(this.rules.accountBulk, subjectOf(principal));
  }

  /** A request whose token was rejected counts like an unauthenticated one. */
  rejectedToken(ip: string): Promise<void> {
    return this.limiter.enforce(this.rules.rejectedToken, ip);
  }

  /** Account creation on the first login, shared across API instances. */
  provisioning(ip: string): Promise<void> {
    return this.limiter.enforce(this.rules.provisioning, ip);
  }
}
