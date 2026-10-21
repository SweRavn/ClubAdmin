// SPDX-License-Identifier: AGPL-3.0-only
// Handlers for domain events from the transactional outbox. Each runs at most
// once per event; its database work commits together with its delivery
// record. External side effects (email, push, cache versions) must be
// idempotent: use event.idempotencyKey.
import { authorizationCacheHandler, type CacheVersions, type OutboxHandler } from "@clubadmin/db";
import { AUTHZ_VERSION_TTL_SECONDS } from "@clubadmin/shared";
import type { Redis } from "ioredis";

/** Version counters in Valkey (INCR is safe to repeat: a newer version only forces a reload). */
export function valkeyCacheVersions(valkey: Redis): CacheVersions {
  return {
    async bump(keys) {
      const pipeline = valkey.multi();
      for (const key of keys) pipeline.incr(key).expire(key, AUTHZ_VERSION_TTL_SECONDS);
      const results = await pipeline.exec();
      const failed = results?.find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error("cache version bump failed");
    },
  };
}

export function createOutboxHandlers(deps: { valkey?: Redis | undefined }): OutboxHandler[] {
  // Without Valkey the API caches nothing across requests, so there is nothing to invalidate.
  return deps.valkey ? [authorizationCacheHandler(valkeyCacheVersions(deps.valkey))] : [];
}
