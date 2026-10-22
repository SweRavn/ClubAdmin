// SPDX-License-Identifier: AGPL-3.0-only
// Valkey keys of the authorization caches (ADR 0006, ADR 0022), shared by the
// API (reads) and the worker (invalidation on domain events). A cached value
// records the version it was loaded at; bumping the version invalidates it.

/** Cached relationship sets and protected sets expire after this long anyway. */
export const AUTHZ_CACHE_TTL_SECONDS = 10 * 60;
/** Version counters outlive every cached value. */
export const AUTHZ_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Version of a person's relationship set. */
export const relationshipVersionKey = (personId: string): string => `authz:rel:v:${personId}`;
/** A person's cached relationship set ({ version, set }). */
export const relationshipSetKey = (personId: string): string => `authz:rel:${personId}`;

/** Version of a club's protected set (club flags and members). */
export const protectedVersionKey = (clubId: string): string => `authz:prot:v:${clubId}`;
/** Version of the global protected flags; a change invalidates every club's protected set. */
export const PROTECTED_GLOBAL_VERSION_KEY = "authz:prot:v:global";
/** A club's cached protected set ({ version, globalVersion, personIds }). */
export const protectedSetKey = (clubId: string): string => `authz:prot:${clubId}`;

/**
 * Valkey pub/sub channel: a club ID published here drops that club's
 * entitlements from every API instance's cache (P0.12).
 */
export const ENTITLEMENTS_INVALIDATE_CHANNEL = "entitlements:invalidate";
