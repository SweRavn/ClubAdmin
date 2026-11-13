// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Keeps a server-rendered chat list fresh (P2.1, "Mina kanaler"): opens the
// real-time connection and refreshes the page when the person's chats or a
// chat's messages change (debounced). Without JavaScript the list is as
// fresh as the last load.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ChatLiveRefresh({ csrf }: { csrf: string }) {
  const router = useRouter();
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const schedule = () => {
      if (refresh) clearTimeout(refresh);
      refresh = setTimeout(() => router.refresh(), 400);
    };
    const connect = async () => {
      try {
        const response = await fetch("/api/v1/realtime/tickets", {
          method: "POST",
          headers: { accept: "application/json", "x-csrf-token": csrf },
        });
        if (!response.ok || closed) throw new Error("ticket");
        const { url } = (await response.json()) as { url: string };
        ws = new WebSocket(url);
        ws.onopen = () => {
          attempt = 0;
        };
        ws.onmessage = (message) => {
          const type = (JSON.parse(String(message.data)) as { type?: string }).type;
          if (
            type === "message.created" ||
            type === "chats.changed" ||
            type === "chat.updated" ||
            type === "message.updated"
          ) {
            schedule();
          }
        };
        ws.onclose = () => {
          if (closed) return;
          attempt++;
          retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
        };
      } catch {
        if (closed) return;
        attempt++;
        retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
      }
    };
    void connect();
    return () => {
      closed = true;
      if (refresh) clearTimeout(refresh);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [csrf, router]);
  return null;
}
