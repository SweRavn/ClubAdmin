// SPDX-License-Identifier: AGPL-3.0-only
// "Mina kanaler" (P2.1): every chat the person is in, across clubs and
// groups, unread first and then by the latest message; live over the
// real-time connection. People only as the API presented them (ADR 0022).
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ChatLiveRefresh } from "../../../../components/chat-live-refresh.tsx";
import { ChatRow } from "../../../../components/chat-parts.tsx";
import { getMyChats, requireSession } from "../../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("chat.title") };
}

export default async function MyChatsPage() {
  const [t, locale, timeZone, page, session] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getMyChats(null),
    requireSession(),
  ]);
  // Unread first; within each, the latest activity first (the API's order).
  const items = [
    ...page.items.filter((c) => c.unreadCount > 0),
    ...page.items.filter((c) => c.unreadCount === 0),
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("chat.title")}</h1>
      <ChatLiveRefresh csrf={session.record.csrf} />
      {items.length === 0 ? (
        <p className="text-muted" data-testid="chats-empty">
          {t("chat.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="my-chats">
          {items.map((chat) => (
            <li key={chat.id}>
              <ChatRow
                chat={chat}
                timeLabel={
                  chat.lastMessageAt
                    ? formatDateTime(chat.lastMessageAt, {
                        locale,
                        timeZone,
                        dateStyle: "short",
                        timeStyle: "short",
                      })
                    : null
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
