// SPDX-License-Identifier: AGPL-3.0-only
// A child's chats for their parent or legal guardian (P2.1 part B, ADR 0047
// rule 6): which chats the child is in and who is in them, never the
// messages. Opening one shows its members; joining is visible to everyone.

import { useTranslations } from "use-intl";

import { useWardChats } from "../../../../api/queries.ts";
import { ChatRow } from "../../../../components/chat-parts.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { EmptyState, Loading, Muted, Screen, Section } from "../../../../components/ui.tsx";
import NotFound from "../../../+not-found.tsx";

export default function WardChatsScreen() {
  const wardId = useIdParam("personId");
  if (!wardId) return <NotFound />;
  return <WardChats wardId={wardId} />;
}

function WardChats({ wardId }: { wardId: string }) {
  const t = useTranslations();
  const chats = useWardChats(wardId);
  if (!chats.data) {
    if (chats.isError)
      return (
        <Screen>
          <ErrorView error={chats.error} onRetry={() => void chats.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const items = chats.data.items;
  return (
    <Screen
      refreshing={chats.isRefetching}
      onRefresh={() => void chats.refetch()}
      testID="ward-chats-screen"
    >
      <Muted>{t("chat.wardChatsHelp")}</Muted>
      <Section title={t("chat.wardChats")}>
        {items.length === 0 ? (
          <EmptyState title={t("chat.wardChatsEmpty")} />
        ) : (
          items.map((chat, index) => (
            <ChatRow key={chat.id} chat={chat} last={index === items.length - 1} />
          ))
        )}
      </Section>
    </Screen>
  );
}
