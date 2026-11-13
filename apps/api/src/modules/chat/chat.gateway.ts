// SPDX-License-Identifier: AGPL-3.0-only
// The real-time connection (P2.1, ADR 0016): a WebSocket at
// /api/v1/realtime?ticket=… (a single-use ticket from POST
// /realtime/tickets). It relays the events of the person's chats and of the
// person themselves (their chats changed, their permissions changed) from
// the Valkey bus, and typing signals between members. Events carry IDs
// only: clients fetch content through the API, where the policies and the
// presenter apply. Message texts never pass through here.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  REALTIME_PATH,
  realtimeChatChannel,
  RealtimeClientEventSchema,
  realtimePersonChannel,
  type RealtimeServerEvent,
} from "@clubadmin/shared";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { type WebSocket, WebSocketServer } from "ws";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { RealtimeBus, RealtimeTickets } from "../realtime/index.ts";
import { ChatService } from "./chat.service.ts";

/** Seconds between pings; a connection that misses one is closed. */
const HEARTBEAT_MS = 30_000;
/** Typing signals per chat and connection. */
const TYPING_INTERVAL_MS = 2_000;
/** Client frames are small JSON objects. */
const MAX_PAYLOAD = 1024;

interface Connection {
  socket: WebSocket;
  personId: string;
  /** Chats the person is an active member of, with their clubs. */
  chats: Map<string, string>;
  alive: boolean;
  typedAt: Map<string, number>;
}

@Injectable()
export class ChatGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly adapterHost: HttpAdapterHost;
  private readonly bus: RealtimeBus;
  private readonly tickets: RealtimeTickets;
  private readonly chats: ChatService;
  private readonly maxPerPerson: number;
  private readonly origins: readonly string[];
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** Connections by channel they listen to. */
  private readonly byChannel = new Map<string, Set<Connection>>();
  private readonly byPerson = new Map<string, Set<Connection>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private server: Server | null = null;
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void this.upgrade(request, socket, head);
  };

  constructor(
    adapterHost: HttpAdapterHost,
    bus: RealtimeBus,
    tickets: RealtimeTickets,
    chats: ChatService,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.adapterHost = adapterHost;
    this.bus = bus;
    this.tickets = tickets;
    this.chats = chats;
    this.maxPerPerson = config.REALTIME_MAX_CONNECTIONS_PER_PERSON;
    this.origins = config.CORS_ORIGINS;
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.server = server;
    server.on("upgrade", this.onUpgrade);
    this.bus.listen((channel, event) => this.relay(channel, event));
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.server?.off("upgrade", this.onUpgrade);
    for (const client of this.wss.clients) client.close(1001, "shutdown");
    this.wss.close();
  }

  /** Connections open on this instance (metrics and tests). */
  get connectionCount(): number {
    return this.wss.clients.size;
  }

  private refuse(socket: Duplex, status: number): void {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\n\r\n`);
    socket.destroy();
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== REALTIME_PATH) {
      socket.destroy();
      return;
    }
    // Browsers send their origin: only the web app's (mobile apps send none).
    const origin = request.headers.origin;
    if (origin && !this.origins.includes(origin)) {
      this.refuse(socket, 403);
      return;
    }
    const holder = await this.tickets.consume(url.searchParams.get("ticket") ?? "");
    if (!holder) {
      this.refuse(socket, 401);
      return;
    }
    if ((this.byPerson.get(holder.personId)?.size ?? 0) >= this.maxPerPerson) {
      this.refuse(socket, 403);
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      void this.open(ws, holder.personId);
    });
  }

  private async open(socket: WebSocket, personId: string): Promise<void> {
    const connection: Connection = {
      socket,
      personId,
      chats: new Map(),
      alive: true,
      typedAt: new Map(),
    };
    const people = this.byPerson.get(personId) ?? new Set<Connection>();
    people.add(connection);
    this.byPerson.set(personId, people);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data: Buffer) => this.receive(connection, data.toString("utf8")));
    socket.on("close", () => void this.close(connection));
    socket.on("error", () => socket.terminate());
    await this.listenTo(connection, [realtimePersonChannel(personId)]);
    await this.refreshChats(connection);
    this.send(connection, { type: "ready", personId });
  }

  private async close(connection: Connection): Promise<void> {
    const channels = [
      realtimePersonChannel(connection.personId),
      ...[...connection.chats.keys()].map(realtimeChatChannel),
    ];
    for (const channel of channels) this.byChannel.get(channel)?.delete(connection);
    this.byPerson.get(connection.personId)?.delete(connection);
    if (this.byPerson.get(connection.personId)?.size === 0) {
      this.byPerson.delete(connection.personId);
    }
    connection.chats.clear();
    await this.bus.unsubscribe(channels);
  }

  private async listenTo(connection: Connection, channels: readonly string[]): Promise<void> {
    for (const channel of channels) {
      const set = this.byChannel.get(channel) ?? new Set<Connection>();
      set.add(connection);
      this.byChannel.set(channel, set);
    }
    await this.bus.subscribe(channels);
  }

  /** The person's active chats now: listens to new ones, stops listening to old ones. */
  private async refreshChats(connection: Connection): Promise<void> {
    const rows = await this.chats.chatIdsOfPerson(connection.personId);
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    const now = new Map(rows.filter((r) => r.status === "active").map((r) => [r.chatId, r.clubId]));
    const added = [...now.keys()].filter((id) => !connection.chats.has(id));
    const removed = [...connection.chats.keys()].filter((id) => !now.has(id));
    for (const id of removed) {
      connection.chats.delete(id);
      this.byChannel.get(realtimeChatChannel(id))?.delete(connection);
    }
    for (const [id, clubId] of now) connection.chats.set(id, clubId);
    await this.bus.unsubscribe(removed.map(realtimeChatChannel));
    await this.listenTo(connection, added.map(realtimeChatChannel));
  }

  private relay(channel: string, event: RealtimeServerEvent): void {
    const connections = this.byChannel.get(channel);
    if (!connections) return;
    for (const connection of [...connections]) {
      // Typing is not echoed to the typist.
      if (event.type === "typing" && event.personId === connection.personId) continue;
      if (event.type === "chats.changed") void this.refreshChats(connection);
      this.send(connection, event);
    }
  }

  private receive(connection: Connection, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = RealtimeClientEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    if (event.type === "ping") {
      this.send(connection, { type: "pong" });
      return;
    }
    // Typing: only in chats the person is an active member of, at most every two seconds.
    const clubId = connection.chats.get(event.chatId);
    if (!clubId) return;
    const now = Date.now();
    if (now - (connection.typedAt.get(event.chatId) ?? 0) < TYPING_INTERVAL_MS) return;
    connection.typedAt.set(event.chatId, now);
    void this.bus.publish(realtimeChatChannel(event.chatId), {
      type: "typing",
      clubId,
      chatId: event.chatId,
      personId: connection.personId,
    });
  }

  private send(connection: Connection, event: RealtimeServerEvent): void {
    if (connection.socket.readyState === connection.socket.OPEN) {
      connection.socket.send(JSON.stringify(event));
    }
  }

  private beat(): void {
    for (const people of this.byPerson.values()) {
      for (const connection of people) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }
}
