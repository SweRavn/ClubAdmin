// SPDX-License-Identifier: AGPL-3.0-only
// Push providers (P1.7, ADR 0039). Expo Push forwards to Apple and Google;
// it is called over HTTPS (https://docs.expo.dev/push-notifications/sending-notifications/),
// at most 100 messages per request. The fake provider records nothing but
// IDs (development and CI); the memory provider keeps the messages (tests).
// Messages carry no person names (see renderNotice); the data payload only
// the notification ID and the link.

export interface PushMessage {
  /** The device's Expo push token. */
  to: string;
  title: string;
  body: string;
  /** Android notification channel: the notice's category. */
  channelId: string;
  data: { notificationId: string; link: string };
}

export type PushTicket = { status: "ok"; id: string | null } | { status: "error"; code: string };

export type PushReceipt = { status: "ok" } | { status: "error"; code: string };

export interface PushProvider {
  readonly name: string;
  /** One ticket per message, in order. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  /** Receipts for tickets (Expo keeps them for about a day). */
  receipts(ids: readonly string[]): Promise<Map<string, PushReceipt>>;
}

export const PUSH_BATCH = 100;
const EXPO_URL = "https://exp.host/--/api/v2/push";

/** An error code from Expo's response (DeviceNotRegistered, MessageTooBig, …), never its text. */
const codeOf = (details: unknown): string =>
  typeof (details as { error?: unknown } | null)?.error === "string"
    ? (details as { error: string }).error
    : "PushError";

export function expoPushProvider(
  options: { accessToken?: string | undefined; fetch?: typeof fetch } = {},
): PushProvider {
  const doFetch = options.fetch ?? fetch;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await doFetch(`${EXPO_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Expo push ${path} answered ${res.status}`);
    return res.json();
  };
  return {
    name: "expo",
    async send(messages) {
      if (messages.length === 0) return [];
      const result = (await post(
        "/send",
        messages.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          channelId: m.channelId,
          sound: "default",
        })),
      )) as { data?: { status: string; id?: string; details?: unknown }[] };
      return messages.map((_, i): PushTicket => {
        const ticket = result.data?.[i];
        return ticket?.status === "ok"
          ? { status: "ok", id: ticket.id ?? null }
          : { status: "error", code: codeOf(ticket?.details) };
      });
    },
    async receipts(ids) {
      const map = new Map<string, PushReceipt>();
      if (ids.length === 0) return map;
      const result = (await post("/getReceipts", { ids })) as {
        data?: Record<string, { status: string; details?: unknown }>;
      };
      for (const [id, receipt] of Object.entries(result.data ?? {})) {
        map.set(
          id,
          receipt.status === "ok"
            ? { status: "ok" }
            : { status: "error", code: codeOf(receipt.details) },
        );
      }
      return map;
    },
  };
}

/** Accepts every token and sends nothing (PUSH_PROVIDER=fake). */
export function fakePushProvider(): PushProvider {
  return {
    name: "fake",
    send: (messages) =>
      Promise.resolve(
        messages.map((m) => ({ status: "ok", id: `fake:${m.data.notificationId}` }) as const),
      ),
    receipts: (ids) => Promise.resolve(new Map(ids.map((id) => [id, { status: "ok" } as const]))),
  };
}

/** Keeps the messages (tests); tokens in `unregistered` get DeviceNotRegistered. */
export function memoryPushProvider(): PushProvider & {
  sent: PushMessage[];
  unregistered: Set<string>;
} {
  const sent: PushMessage[] = [];
  const unregistered = new Set<string>();
  return {
    name: "memory",
    sent,
    unregistered,
    send(messages) {
      sent.push(...messages);
      return Promise.resolve(
        messages.map((m) =>
          unregistered.has(m.to)
            ? ({ status: "error", code: "DeviceNotRegistered" } as const)
            : ({ status: "ok", id: `memory:${sent.length}:${m.data.notificationId}` } as const),
        ),
      );
    },
    receipts: (ids) => Promise.resolve(new Map(ids.map((id) => [id, { status: "ok" } as const]))),
  };
}
