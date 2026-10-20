// SPDX-License-Identifier: AGPL-3.0-only
// Valkey (Redis protocol) client for rate limiting, caches and pub/sub (ADR 0010).

import { Redis } from "ioredis";

export const VALKEY_CLIENT = Symbol("VALKEY_CLIENT");

export type ValkeyClient = Redis | undefined;

export function createValkeyClient(url: string | undefined): ValkeyClient {
  if (!url) return undefined;
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectionName: "clubadmin-api",
  });
  // Reconnects automatically; connection errors are reported by health checks.
  client.on("error", () => undefined);
  return client;
}
