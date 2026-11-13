// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A chat in the browser (P2.1): the messages, sending (with a client-chosen
// UUIDv7 so a resend after a network error is safe), editing, deleting
// (hidden, never removed: ADR 0047), reactions, read receipts and "is
// typing". New messages arrive over the API's WebSocket: a ticket from the
// BFF, then events with IDs only; the content is fetched through the BFF,
// where the API's policies and presenter apply. Texts come translated from
// the server (no i18n runtime in the browser).

import type { ChatMessage, ChatPerson, RealtimeServerEvent } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ChatRoomTexts {
  placeholder: string;
  send: string;
  sending: string;
  failed: string;
  edited: string;
  hiddenBySender: string;
  hiddenByModerator: string;
  reply: string;
  replyingTo: string;
  cancel: string;
  edit: string;
  save: string;
  delete: string;
  deleteConfirm: string;
  versions: string;
  typing: string;
  offline: string;
  loadOlder: string;
  readBy: string;
  someone: string;
  protectedPerson: string;
  formerMember: string;
  noMessages: string;
  system: Record<string, string>;
}

interface Props {
  clubId: string;
  chatId: string;
  meId: string;
  csrf: string;
  canPost: boolean;
  /** Newest first, as the API pages them. */
  initial: ChatMessage[];
  initialCursor: string | null;
  /** Names of the people the viewer may see, by ID (members and authors). */
  names: Record<string, string>;
  /** Each member's last read message (read receipts). */
  readPointers: Record<string, string | null>;
  locale: string;
  timeZone: string;
  texts: ChatRoomTexts;
}

const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮"];

/** A UUIDv7 (time-ordered): the message's ID chosen by the client. */
function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The UUID just below `id`, so `after` returns the message itself first. */
function precedingId(id: string): string {
  const value = BigInt(`0x${id.replace(/-/g, "")}`) - 1n;
  const out = value.toString(16).padStart(32, "0");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

export function ChatRoom(props: Props) {
  const { clubId, chatId, meId, csrf, texts } = props;
  const base = `/api/v1/clubs/${clubId}/chats/${chatId}`;
  // Oldest first on screen.
  const [messages, setMessages] = useState<ChatMessage[]>(() => [...props.initial].reverse());
  const [cursor, setCursor] = useState(props.initialCursor);
  const [pending, setPending] = useState<{ id: string; body: string; failed: boolean }[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [reads, setReads] = useState(props.readPointers);
  const [online, setOnline] = useState(true);
  const [versions, setVersions] = useState<Record<string, { body: string; writtenAt: string }[]>>(
    {},
  );
  const socket = useRef<WebSocket | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const newest = useRef<string | null>(props.initial[0]?.id ?? null);

  const call = useCallback(
    async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await fetch(path, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.method && init.method !== "GET" ? { "x-csrf-token": csrf } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.status === 204 ? null : ((await response.json()) as unknown);
    },
    [csrf],
  );

  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    });
    setPending((p) => p.filter((x) => !incoming.some((m) => m.id === x.id)));
    const last = incoming.at(-1)?.id;
    if (last && (!newest.current || last > newest.current)) newest.current = last;
  }, []);

  const catchUp = useCallback(async () => {
    const after = newest.current;
    const query = after ? `?after=${after}&limit=100` : "?limit=50";
    const page = (await call(`${base}/messages${query}`)) as { items: ChatMessage[] };
    merge(after ? page.items : [...page.items].reverse());
  }, [base, call, merge]);

  const refreshOne = useCallback(
    async (messageId: string) => {
      const page = (await call(`${base}/messages?after=${precedingId(messageId)}&limit=1`)) as {
        items: ChatMessage[];
      };
      merge(page.items);
    },
    [base, call, merge],
  );

  const markRead = useCallback(() => {
    const last = newest.current;
    if (!last || document.visibilityState !== "visible") return;
    if (reads[meId] && reads[meId] >= last) return;
    setReads((r) => ({ ...r, [meId]: last }));
    void call(`${base}/read`, { method: "POST", body: { messageId: last } }).catch(() => undefined);
  }, [base, call, meId, reads]);

  // The real-time connection, reconnecting with backoff; every reconnect catches up.
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const ticket = (await call("/api/v1/realtime/tickets", { method: "POST" })) as {
          url: string;
        };
        if (closed) return;
        const ws = new WebSocket(ticket.url);
        socket.current = ws;
        ws.onopen = () => {
          attempt = 0;
          setOnline(true);
          void catchUp().catch(() => undefined);
        };
        ws.onmessage = (message) => {
          let event: RealtimeServerEvent;
          try {
            event = JSON.parse(String(message.data)) as RealtimeServerEvent;
          } catch {
            return;
          }
          if (!("chatId" in event) || event.chatId !== chatId) return;
          if (event.type === "message.created") void catchUp().catch(() => undefined);
          if (event.type === "message.updated")
            void refreshOne(event.messageId).catch(() => undefined);
          if (event.type === "chat.read")
            setReads((r) => ({ ...r, [event.personId]: event.messageId }));
          if (event.type === "typing") setTyping((t) => ({ ...t, [event.personId]: Date.now() }));
        };
        ws.onclose = () => {
          socket.current = null;
          setOnline(false);
          if (closed) return;
          attempt++;
          timer = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
        };
      } catch {
        setOnline(false);
        attempt++;
        if (!closed)
          timer = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** attempt));
      }
    };
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket.current?.close();
    };
  }, [call, catchUp, chatId, refreshOne]);

  // Typing indicators fade after four seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(t).filter(([, at]) => now - at < 4000));
        return Object.keys(next).length === Object.keys(t).length ? t : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
    markRead();
  }, [messages.length, markRead]);

  useEffect(() => {
    const onVisible = () => markRead();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  const nameOf = useCallback(
    (person: ChatPerson | null, id?: string | null): string => {
      if (person?.kind === "person") return personLabel(person.person);
      if (person?.kind === "former_member") return texts.formerMember;
      if (person?.kind === "protected") return texts.protectedPerson;
      return (id && props.names[id]) || texts.someone;
    },
    [props.names, texts],
  );

  const send = async (body: string, id = uuidv7(), reply = replyTo) => {
    setPending((p) => [...p.filter((x) => x.id !== id), { id, body, failed: false }]);
    setDraft("");
    setReplyTo(null);
    try {
      const sent = (await call(`${base}/messages`, {
        method: "POST",
        body: { id, body, ...(reply ? { replyToId: reply.id } : {}) },
      })) as ChatMessage;
      merge([sent]);
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, failed: true } : x)));
    }
  };

  // Failed messages are resent when the connection is back (same ID: never twice).
  useEffect(() => {
    if (!online) return;
    for (const p of pending.filter((x) => x.failed)) void send(p.body, p.id, null);
  }, [online]);

  const typingNames = Object.keys(typing)
    .filter((id) => id !== meId)
    .map((id) => props.names[id] ?? texts.someone);

  const readCount = useMemo(() => {
    const counts = new Map<string, number>();
    const pointers = Object.entries(reads).filter(([id, at]) => id !== meId && at);
    for (const m of messages) {
      if (m.senderId !== meId) continue;
      counts.set(m.id, pointers.filter(([, at]) => at! >= m.id).length);
    }
    return counts;
  }, [messages, reads, meId]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat(props.locale, {
      timeZone: props.timeZone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));

  const older = async () => {
    if (!cursor) return;
    const page = (await call(`${base}/messages?cursor=${cursor}&limit=50`)) as {
      items: ChatMessage[];
      nextCursor: string | null;
    };
    setCursor(page.nextCursor);
    setMessages((current) => [...[...page.items].reverse(), ...current]);
  };

  return (
    <div className="flex min-h-[60vh] flex-col gap-3" data-testid="chat-room">
      {!online ? (
        <p role="status" className="rounded-md bg-protected-soft px-3 py-1 text-sm">
          {texts.offline}
        </p>
      ) : null}
      {cursor ? (
        <button
          type="button"
          onClick={() => void older()}
          className="self-center text-sm underline"
        >
          {texts.loadOlder}
        </button>
      ) : null}
      {messages.length === 0 && pending.length === 0 ? (
        <p className="text-muted">{texts.noMessages}</p>
      ) : null}
      <ol className="flex flex-col gap-2" aria-live="polite" data-testid="chat-messages">
        {messages.map((m) => {
          if (m.kind === "system" && m.event) {
            const names = m.event.personIds.map((id) => props.names[id] ?? texts.someone);
            return (
              <li key={m.id} className="text-center text-sm text-muted" data-testid="chat-system">
                {fill(texts.system[m.event.type] ?? "", { names: names.join(", ") })}
              </li>
            );
          }
          const mine = m.senderId === meId;
          return (
            <li
              key={m.id}
              className={`max-w-[85%] rounded-lg px-3 py-2 ${mine ? "self-end bg-accent-soft" : "self-start border border-border"}`}
              data-testid="chat-message"
            >
              <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
                <span className="font-semibold text-fg">{nameOf(m.sender, m.senderId)}</span>
                <time dateTime={m.createdAt}>{time(m.createdAt)}</time>
                {m.editedAt ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      void call(`${base}/messages/${m.id}/versions`).then((v) =>
                        setVersions((all) => ({
                          ...all,
                          [m.id]: (v as { items: { body: string; writtenAt: string }[] }).items,
                        })),
                      )
                    }
                  >
                    {texts.edited}
                  </button>
                ) : null}
              </div>
              {m.replyTo ? (
                <blockquote className="mt-1 border-l-2 border-border pl-2 text-sm text-muted">
                  {nameOf(m.replyTo.sender)}: {m.replyTo.excerpt}
                </blockquote>
              ) : null}
              {m.hidden ? (
                <p className="italic text-muted">
                  {m.hidden === "moderator" ? texts.hiddenByModerator : texts.hiddenBySender}
                </p>
              ) : editing?.id === m.id ? (
                <form
                  className="mt-1 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const body = editing.body.trim();
                    setEditing(null);
                    if (body) {
                      void call(`${base}/messages/${m.id}`, { method: "PATCH", body: { body } })
                        .then((updated) => merge([updated as ChatMessage]))
                        .catch(() => undefined);
                    }
                  }}
                >
                  <input
                    className="flex-1 rounded-md border border-border px-2 py-1"
                    value={editing.body}
                    maxLength={4000}
                    onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                  />
                  <button type="submit" className="text-sm underline">
                    {texts.save}
                  </button>
                  <button type="button" className="text-sm" onClick={() => setEditing(null)}>
                    {texts.cancel}
                  </button>
                </form>
              ) : (
                <p className="whitespace-pre-wrap break-words" data-testid="chat-body">
                  {m.body}
                </p>
              )}
              {versions[m.id] ? (
                <details open className="mt-1 text-xs text-muted">
                  <summary>{texts.versions}</summary>
                  <ul>
                    {versions[m.id]!.map((v) => (
                      <li key={v.writtenAt}>
                        <time dateTime={v.writtenAt}>{time(v.writtenAt)}</time>: {v.body}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {!m.hidden ? (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-sm">
                  {m.reactions.map((r) => (
                    <button
                      key={r.emoji}
                      type="button"
                      aria-pressed={r.mine}
                      disabled={!props.canPost}
                      className="rounded-full border border-border px-2 aria-pressed:bg-accent-soft"
                      onClick={() =>
                        void call(`${base}/messages/${m.id}/reactions`, {
                          method: "POST",
                          body: { emoji: r.emoji, on: !r.mine },
                        }).then((u) => merge([u as ChatMessage]))
                      }
                    >
                      {r.emoji} {r.count}
                    </button>
                  ))}
                  {props.canPost ? (
                    <details className="relative">
                      <summary className="cursor-pointer list-none px-1 text-muted">＋</summary>
                      <div className="absolute z-10 flex gap-1 rounded-md border border-border bg-bg p-1">
                        {REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() =>
                              void call(`${base}/messages/${m.id}/reactions`, {
                                method: "POST",
                                body: { emoji, on: true },
                              }).then((u) => merge([u as ChatMessage]))
                            }
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {props.canPost ? (
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => setReplyTo(m)}
                    >
                      {texts.reply}
                    </button>
                  ) : null}
                  {mine && props.canPost ? (
                    <>
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => setEditing({ id: m.id, body: m.body })}
                      >
                        {texts.edit}
                      </button>
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => {
                          if (!window.confirm(texts.deleteConfirm)) return;
                          void call(`${base}/messages/${m.id}`, { method: "DELETE" }).then(() =>
                            refreshOne(m.id),
                          );
                        }}
                      >
                        {texts.delete}
                      </button>
                      {readCount.get(m.id) ? (
                        <span className="ml-auto text-xs text-muted">
                          {fill(texts.readBy, { count: String(readCount.get(m.id)) })}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {pending.map((p) => (
          <li
            key={p.id}
            className="max-w-[85%] self-end rounded-lg bg-accent-soft px-3 py-2 opacity-70"
            data-testid="chat-pending"
          >
            <p className="whitespace-pre-wrap break-words">{p.body}</p>
            <p className="text-xs text-muted">{p.failed ? texts.failed : texts.sending}</p>
          </li>
        ))}
      </ol>
      <div ref={bottom} />
      <p className="h-5 text-sm text-muted" aria-live="polite">
        {typingNames.length > 0 ? fill(texts.typing, { name: typingNames.join(", ") }) : ""}
      </p>
      {props.canPost ? (
        <form
          className="sticky bottom-0 flex flex-col gap-1 bg-bg py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (body) void send(body);
          }}
        >
          {replyTo ? (
            <p className="text-sm text-muted">
              {fill(texts.replyingTo, { name: nameOf(replyTo.sender, replyTo.senderId) })}{" "}
              <button type="button" className="underline" onClick={() => setReplyTo(null)}>
                {texts.cancel}
              </button>
            </p>
          ) : null}
          <div className="flex gap-2">
            <textarea
              aria-label={texts.placeholder}
              placeholder={texts.placeholder}
              className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-border px-3 py-2"
              maxLength={4000}
              rows={1}
              value={draft}
              data-testid="chat-input"
              onChange={(e) => {
                setDraft(e.target.value);
                if (socket.current?.readyState === WebSocket.OPEN) {
                  socket.current.send(JSON.stringify({ type: "typing", chatId }));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const body = draft.trim();
                  if (body) void send(body);
                }
              }}
            />
            <button
              type="submit"
              className="rounded-md bg-accent px-4 py-2 text-accent-fg"
              data-testid="chat-send"
            >
              {texts.send}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
