// SPDX-License-Identifier: AGPL-3.0-only
// The real-time connection (P2.1, ADR 0047): while a chat screen is open and
// the app is in the foreground, one WebSocket to the API (a single-use
// ticket from POST /realtime/tickets, then the URL it names). Events carry
// IDs only; they mark the cached chat data stale, so the screens refetch
// what changed, and "typing" goes to the open chat. The connection closes
// when no chat screen is open or the app goes to the background, and
// reconnects with backoff.

import type { ApiClient } from "@clubadmin/api-client";
import type { RealtimeServerEvent } from "@clubadmin/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { useSession } from "../state/session.tsx";

type Listener = (event: RealtimeServerEvent) => void;

class Connection {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private active = AppState.currentState === "active";
  private readonly listeners = new Set<Listener>();
  private readonly states = new Set<(open: boolean) => void>();
  private readonly appState: { remove: () => void };
  open = false;

  constructor(
    private readonly api: ApiClient,
    private readonly client: QueryClient,
    private readonly personId: string,
  ) {
    this.appState = AppState.addEventListener("change", (state) => {
      this.active = state === "active";
      this.update();
    });
  }

  subscribe(listener: Listener, onState: (open: boolean) => void): () => void {
    this.listeners.add(listener);
    this.states.add(onState);
    this.update();
    return () => {
      this.listeners.delete(listener);
      this.states.delete(onState);
      this.update();
    };
  }

  dispose(): void {
    this.appState.remove();
    this.listeners.clear();
    this.update();
  }

  private update(): void {
    const wanted = this.active && this.listeners.size > 0;
    if (wanted && !this.ws && !this.retry) void this.connect();
    if (!wanted) this.close();
  }

  private close(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    for (const state of this.states) state(open);
  }

  private reconnect(): void {
    this.ws = null;
    this.setOpen(false);
    if (!this.active || this.listeners.size === 0) return;
    this.attempt++;
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        this.update();
      },
      Math.min(30_000, 1000 * 2 ** this.attempt),
    );
  }

  private async connect(): Promise<void> {
    const placeholder = {} as WebSocket;
    this.ws = placeholder;
    try {
      const { data } = await this.api.POST("/api/v1/realtime/tickets");
      if (!data || this.ws !== placeholder) throw new Error("ticket");
      const ws = new WebSocket(data.url);
      this.ws = ws;
      ws.onopen = () => {
        this.attempt = 0;
        this.setOpen(true);
        // Whatever happened while disconnected.
        this.invalidateChats();
      };
      ws.onmessage = (message) => {
        let event: RealtimeServerEvent;
        try {
          event = JSON.parse(String(message.data)) as RealtimeServerEvent;
        } catch {
          return;
        }
        this.handle(event);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.reconnect();
      };
    } catch {
      if (this.ws === placeholder) this.reconnect();
    }
  }

  private invalidateChats(chatId?: string): void {
    void this.client.invalidateQueries({ queryKey: ["chats", this.personId] });
    if (chatId) void this.client.invalidateQueries({ queryKey: ["chat", this.personId, chatId] });
  }

  private handle(event: RealtimeServerEvent): void {
    switch (event.type) {
      case "message.created":
      case "message.updated":
      case "chat.updated":
        this.invalidateChats(event.chatId);
        break;
      case "chat.read":
        if (event.personId === this.personId) this.invalidateChats();
        break;
      case "chats.changed":
        this.invalidateChats();
        break;
      case "authz.changed":
        void this.client.invalidateQueries();
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(event);
  }

  /** "Typing" in a chat (ignored while not connected). */
  typing(chatId: string): void {
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "typing", chatId }));
    }
  }
}

let current: { key: string; connection: Connection } | null = null;

function connectionFor(api: ApiClient, client: QueryClient, personId: string): Connection {
  // A new login (or account) gets a new connection.
  if (current?.key !== personId) {
    current?.connection.dispose();
    current = { key: personId, connection: new Connection(api, client, personId) };
  }
  return current.connection;
}

/**
 * Keeps the real-time connection open while the calling screen is mounted.
 * Returns whether it is connected and a way to send "typing".
 */
export function useRealtime(listener?: Listener): {
  connected: boolean;
  typing: (chatId: string) => void;
} {
  const { api, personId } = useSession();
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  }, [listener]);
  useEffect(() => {
    if (!personId) return;
    const connection = connectionFor(api, client, personId);
    setConnected(connection.open);
    return connection.subscribe((event) => latest.current?.(event), setConnected);
  }, [api, client, personId]);
  return {
    connected,
    typing: (chatId) => {
      if (personId) current?.connection.typing(chatId);
    },
  };
}
