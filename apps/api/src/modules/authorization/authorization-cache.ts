// SPDX-License-Identifier: AGPL-3.0-only
// Valkey caches of the authorization module, invalidated by version counters
// that the worker bumps on domain events (@clubadmin/db authorizationCacheHandler).
// One round trip (MGET of version and value) per read. Without Valkey, or
// when it is unavailable, every request loads from the database: never stale.

import {
  AUTHZ_CACHE_TTL_SECONDS,
  PROTECTED_GLOBAL_VERSION_KEY,
  protectedSetKey,
  protectedVersionKey,
  relationshipSetKey,
  relationshipVersionKey,
} from "@clubadmin/shared";

import type { ValkeyClient } from "../../platform/infra/valkey.ts";
import type { RelationshipSet } from "./relationship-set.ts";

interface Versioned<T> {
  v: string;
  g?: string;
  value: T;
}

const parse = <T>(raw: string | null): Versioned<T> | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Versioned<T>;
  } catch {
    return null;
  }
};

export class AuthorizationCache {
  private readonly valkey: ValkeyClient;

  constructor(valkey: ValkeyClient) {
    this.valkey = valkey;
  }

  private get client() {
    return this.valkey?.status === "ready" ? this.valkey : undefined;
  }

  async relationshipSet(
    personId: string,
    load: () => Promise<RelationshipSet>,
  ): Promise<RelationshipSet> {
    const client = this.client;
    const read = await client
      ?.mget(relationshipVersionKey(personId), relationshipSetKey(personId))
      .catch(() => undefined);
    if (!client || !read) return load();
    const [v, raw] = read;
    const version = v ?? "0";
    const cached = parse<RelationshipSet>(raw ?? null);
    if (cached && cached.v === version) return cached.value;
    // Stored under the version read before loading: a change committed while
    // loading bumps the version, so this entry is never served as current.
    const value = await load();
    await client
      .set(
        relationshipSetKey(personId),
        JSON.stringify({ v: version, value } satisfies Versioned<RelationshipSet>),
        "EX",
        AUTHZ_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
    return value;
  }

  async protectedSet(clubId: string, load: () => Promise<string[]>): Promise<string[]> {
    const client = this.client;
    const read = await client
      ?.mget(protectedVersionKey(clubId), PROTECTED_GLOBAL_VERSION_KEY, protectedSetKey(clubId))
      .catch(() => undefined);
    if (!client || !read) return load();
    const [v, g, raw] = read;
    const version = v ?? "0";
    const global = g ?? "0";
    const cached = parse<string[]>(raw ?? null);
    if (cached && cached.v === version && cached.g === global) return cached.value;
    const value = await load();
    await client
      .set(
        protectedSetKey(clubId),
        JSON.stringify({ v: version, g: global, value } satisfies Versioned<string[]>),
        "EX",
        AUTHZ_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
    return value;
  }
}
