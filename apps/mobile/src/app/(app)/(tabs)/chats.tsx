// SPDX-License-Identifier: AGPL-3.0-only
// "Mina kanaler" (P2.1): every chat the person is in, across clubs and
// groups, unread first and then by the latest message. Cache first: the
// cached list shows at once; real-time events mark it stale. People only as
// the API presented them (ADR 0022).

import { useTranslations } from "use-intl";

import { useMyChats } from "../../../api/queries.ts";
import { useRealtime } from "../../../api/realtime.ts";
import { ChatRow } from "../../../components/chat-parts.tsx";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button, EmptyState, Loading, Screen, Section } from "../../../components/ui.tsx";

export default function MyChats() {
  const t = useTranslations();
  const chats = useMyChats();
  useRealtime();
  if (!chats.data) {
    if (chats.isError)
      return (
        <Screen>
          <ErrorView error={chats.error} onRetry={() => void chats.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const all = chats.data.pages.flatMap((page) => page.items);
  const items = [
    ...all.filter((c) => c.unreadCount > 0),
    ...all.filter((c) => c.unreadCount === 0),
  ];
  return (
    <Screen
      refreshing={chats.isRefetching}
      onRefresh={() => void chats.refetch()}
      testID="chats-screen"
    >
      <DataAge updatedAt={chats.dataUpdatedAt} />
      <Section title={t("chat.title")}>
        {items.length === 0 ? (
          <EmptyState title={t("chat.empty")} />
        ) : (
          items.map((chat, index) => (
            <ChatRow key={chat.id} chat={chat} last={index === items.length - 1} />
          ))
        )}
      </Section>
      {chats.hasNextPage ? (
        <Button
          label={t("common.loadMore")}
          kind="secondary"
          busy={chats.isFetchingNextPage}
          onPress={() => void chats.fetchNextPage()}
          testID="chats-more"
        />
      ) : null}
    </Screen>
  );
}
