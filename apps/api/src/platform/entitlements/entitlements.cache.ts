// SPDX-License-Identifier: AGPL-3.0-only
// Per-instance cache of club entitlements: a Map lookup per request, no
// database query (docs/performance.md: has() < 0.1 ms with a warm cache).
// Changes (plan, subscription status, access state) invalidate the entry here
// and, through Valkey pub/sub, on every other API instance; the worker does
// the same for changes it makes. Entries also expire after a minute.

import { ENTITLEMENTS_INVALIDATE_CHANNEL } from "@clubadmin/shared";
import type { Redis } from "ioredis";

import type { ValkeyClient } from "../infra/valkey.ts";

export const ENTITLEMENTS_CHANNEL = ENTITLEMENTS_INVALIDATE_CHANNEL;
const TTL_MS = 60_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class EntitlementsCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly loading = new Map<string, Promise<T>>();
  private readonly valkey: ValkeyClient;
  private subscriber: Redis | undefined;
  private readonly now: () => number;

  constructor(valkey: ValkeyClient, now: () => number = Date.now) {
    this.valkey = valkey;
    this.now = now;
  }

  /** Listens for invalidations from other instances and the worker. */
  async start(): Promise<void> {
    if (!this.valkey || this.subscriber) return;
    const subscriber = this.valkey.duplicate({ lazyConnect: true });
    subscriber.on("error", () => undefined);
    subscriber.on("message", (_channel: string, clubId: string) => this.entries.delete(clubId));
    this.subscriber = subscriber;
    try {
      await subscriber.connect();
      await subscriber.subscribe(ENTITLEMENTS_CHANNEL);
    } catch {
      // Without pub/sub entries still expire after TTL_MS.
    }
  }

  async stop(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    await subscriber?.quit().catch(() => undefined);
  }

  get(clubId: string, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(clubId);
    if (entry && entry.expiresAt > this.now()) return Promise.resolve(entry.value);
    const pending = this.loading.get(clubId);
    if (pending) return pending;
    const promise = load()
      .then((value) => {
        // An invalidation while loading wins: do not store a value read before it.
        if (this.loading.get(clubId) === promise) {
          this.entries.set(clubId, { value, expiresAt: this.now() + TTL_MS });
        }
        return value;
      })
      .finally(() => {
        if (this.loading.get(clubId) === promise) this.loading.delete(clubId);
      });
    this.loading.set(clubId, promise);
    return promise;
  }

  /** Drops the club's entry here and on every other instance. */
  async invalidate(clubId: string): Promise<void> {
    this.entries.delete(clubId);
    this.loading.delete(clubId);
    if (this.valkey?.status === "ready") {
      await this.valkey.publish(ENTITLEMENTS_CHANNEL, clubId).catch(() => undefined);
    }
  }
}
