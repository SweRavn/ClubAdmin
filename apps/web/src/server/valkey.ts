// SPDX-License-Identifier: AGPL-3.0-only
import { Redis } from "ioredis";

import { webConfig } from "./config.ts";

let client: Redis | undefined;

/** One connection per server process (kept across hot reloads in development). */
export function valkey(): Redis {
  const holder = globalThis as { __clubadminValkey?: Redis };
  client ??= holder.__clubadminValkey ??= new Redis(webConfig().VALKEY_URL, {
    maxRetriesPerRequest: 2,
  });
  return client;
}
