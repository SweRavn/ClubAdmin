// SPDX-License-Identifier: AGPL-3.0-only
// A child's chats for their parent or legal guardian (P2.1 part B, ADR 0047
// rule 6): which chats the child is in and who is in them, never the
// messages. Joining a chat (visibly to everyone in it) is on the chat's page.
import { formatDateTime, PersonName } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ChatRow } from "../../../../../../components/chat-parts.tsx";
import { getMyWards, getWardChats, requireId } from "../../../../../../server/data.ts";

type Props = { params: Promise<{ personId: string }> };

export async function generateMetadata() {
  return { title: (await getTranslations())("chat.wardChats") };
}

export default async function WardChatsPage({ params }: Props) {
  const personId = requireId((await params).personId);
  const [t, locale, timeZone, wards, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getMyWards(),
    getWardChats(personId),
  ]);
  const ward = wards.wards.find((w) => w.person.id === personId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        <a href="/me/family" className="underline">
          {t("family.title")}
        </a>
      </p>
      <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
        {ward ? <PersonName person={ward.person} protectedLabel={t("protected.tooltip")} /> : null}
        <span>· {t("chat.wardChats")}</span>
      </h1>
      <p className="max-w-prose text-sm text-muted">{t("chat.wardChatsHelp")}</p>
      {page.items.length === 0 ? (
        <p className="text-muted">{t("chat.wardChatsEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border" data-testid="ward-chat-list">
          {page.items.map((chat) => (
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
