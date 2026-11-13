// SPDX-License-Identifier: AGPL-3.0-only
// Real-time events between API instances (P2.1, ADR 0016): published on
// Valkey channels per chat and per person; every instance's gateway relays
// them to its connections. Without Valkey (tests, a single instance) the
// events stay in this process. Events carry IDs only (ADR 0022).

import { EventEmitter } from "node:events";

import {
  realtimeChatChannel,
  realtimePersonChannel,
  type RealtimeServerEvent,
} from "@clubadmin/shared";
import type { Redis } from "ioredis";

export type RealtimeListener = (channel: string, event: RealtimeServerEvent) => void;

/** Publishes events and lets the gateway subscribe to channels. */
export class RealtimeBus {
  private readonly valkey: Redis | undefined;
  private subscriber: Redis | undefined;
  private readonly local = new EventEmitter();
  /** Channels this process listens to, with how many connections want each. */
  private readonly counts = new Map<string, number>();
  private listener: RealtimeListener | null = null;

  constructor(valkey: Redis | undefined) {
    this.valkey = valkey;
    this.local.setMaxListeners(0);
  }

  /** The gateway's single listener for every subscribed channel. */
  listen(listener: RealtimeListener): void {
    this.listener = listener;
    if (this.valkey && !this.subscriber) {
      // A dedicated connection: a Redis connection in subscriber mode serves nothing else.
      this.subscriber = this.valkey.duplicate({ connectionName: "clubadmin-api-realtime" });
      this.subscriber.on("error", () => undefined);
      this.subscriber.on("message", (channel: string, message: string) => {
        this.deliver(channel, message);
      });
    }
  }

  private deliver(channel: string, message: string): void {
    if (!this.listener || !this.counts.has(channel)) return;
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(message) as RealtimeServerEvent;
    } catch {
      return;
    }
    this.listener(channel, event);
  }

  async subscribe(channels: readonly string[]): Promise<void> {
    const fresh: string[] = [];
    for (const channel of channels) {
      const count = this.counts.get(channel) ?? 0;
      if (count === 0) fresh.push(channel);
      this.counts.set(channel, count + 1);
    }
    if (fresh.length === 0) return;
    if (this.subscriber) {
      await this.subscriber.subscribe(...fresh).catch(() => undefined);
    } else {
      for (const channel of fresh) this.local.on(channel, this.onLocal(channel));
    }
  }

  async unsubscribe(channels: readonly string[]): Promise<void> {
    const gone: string[] = [];
    for (const channel of channels) {
      const count = (this.counts.get(channel) ?? 0) - 1;
      if (count <= 0) {
        this.counts.delete(channel);
        gone.push(channel);
      } else {
        this.counts.set(channel, count);
      }
    }
    if (gone.length === 0) return;
    if (this.subscriber) {
      await this.subscriber.unsubscribe(...gone).catch(() => undefined);
    } else {
      for (const channel of gone) this.local.removeAllListeners(channel);
    }
  }

  private readonly localHandlers = new Map<string, (message: string) => void>();
  private onLocal(channel: string): (message: string) => void {
    let handler = this.localHandlers.get(channel);
    if (!handler) {
      handler = (message: string) => this.deliver(channel, message);
      this.localHandlers.set(channel, handler);
    }
    return handler;
  }

  /** Publishes to channels; failures are swallowed (clients catch up through the API). */
  async publish(channel: string, event: RealtimeServerEvent): Promise<void> {
    const message = JSON.stringify(event);
    if (this.valkey) {
      await this.valkey.publish(channel, message).catch(() => undefined);
    } else {
      this.local.emit(channel, message);
    }
  }

  async close(): Promise<void> {
    this.listener = null;
    this.counts.clear();
    this.local.removeAllListeners();
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = undefined;
  }
}

/** What the domain publishes after its transaction committed. */
export class RealtimePublisher {
  private readonly bus: RealtimeBus;

  constructor(bus: RealtimeBus) {
    this.bus = bus;
  }

  toChat(chatId: string, event: RealtimeServerEvent): Promise<void> {
    return this.bus.publish(realtimeChatChannel(chatId), event);
  }

  async toPeople(personIds: Iterable<string>, event: RealtimeServerEvent): Promise<void> {
    await Promise.all(
      [...new Set(personIds)].map((id) => this.bus.publish(realtimePersonChannel(id), event)),
    );
  }
}
