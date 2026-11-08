// SPDX-License-Identifier: AGPL-3.0-only
// The BFF's Valkey connection (sessions, login flows, rate limits).
import { Redis } from "ioredis";

import { webConfig } from "./config.ts";

let client: Redis | undefined;

/** The page shown when the session store cannot be reached. */
export const UNAVAILABLE_PATH = "/unavailable";

/**
 * One connection per server process (kept across hot reloads in development).
 * TCP keep-alive stops idle connections from being dropped silently (Docker
 * port forwarding and WSL2 do, e.g. after the computer slept); a dropped
 * connection is reconnected at once and a command waits for it instead of
 * failing on the first broken write. Errors are logged once per outage,
 * never as unhandled error events.
 */
export function valkey(): Redis {
  const holder = globalThis as { __clubadminValkey?: Redis };
  client ??= holder.__clubadminValkey ??= createValkey(webConfig().VALKEY_URL);
  return client;
}

export function createValkey(url: string): Redis {
  const redis = new Redis(url, {
    connectionName: "clubadmin-web",
    keepAlive: 30_000,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 5,
    retryStrategy: (times) => Math.min(times * 100, 2_000),
    // A reset connection is reconnected and the command sent again.
    reconnectOnError: (error) => /ECONNRESET|EPIPE|READONLY/.test(error.message),
  });
  let down = false;
  redis.on("error", (error: Error) => {
    if (down) return;
    down = true;
    console.warn(`valkey: connection problem (${error.message.split("\n")[0]}); reconnecting`);
  });
  redis.on("ready", () => {
    down = false;
  });
  return redis;
}

/**
 * Whether an error means Valkey cannot be reached (refused, reset, timed out,
 * or ioredis gave up on a command), not a bug in the caller (P1.14 finding 4).
 */
export function isValkeyUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "MaxRetriesPerRequestError" ||
    /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|Connection is closed|max retries per request/i.test(
      error.message,
    )
  );
}
