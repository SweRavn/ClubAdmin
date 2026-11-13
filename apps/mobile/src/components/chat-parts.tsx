// SPDX-License-Identifier: AGPL-3.0-only
// Parts of the chat screens (P2.1): a chat person's label (only as the API
// presented them, ADR 0022: people the viewer may not see by name are
// "a member with protected identity" or "a former member"), a chat's title
// and the row of "Mina kanaler" and of a group's channels.

import { personLabel } from "@clubadmin/shared";
import { router } from "expo-router";
import { Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type { ChatPerson, ChatSummary } from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { ProtectedBadge } from "./protected-badge.tsx";
import { RoleBadge } from "./role-badge.tsx";
import { Muted, Row } from "./ui.tsx";

export function useChatPersonLabel(): (person: ChatPerson | null | undefined) => string {
  const t = useTranslations();
  return (person) => {
    if (person?.kind === "person") return personLabel(person.person);
    if (person?.kind === "former_member") return t("chat.formerMember");
    if (person?.kind === "protected") return t("chat.protectedPerson");
    return t("chat.someone");
  };
}

export function useChatTitle(): (chat: ChatSummary) => string {
  const label = useChatPersonLabel();
  return (chat) => (chat.kind === "direct" ? label(chat.counterpart) : (chat.name ?? ""));
}

export function ChatRow({
  chat,
  showContext = true,
  last,
}: {
  chat: ChatSummary;
  showContext?: boolean;
  last?: boolean;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const format = useFormatter();
  const label = useChatPersonLabel();
  const title = useChatTitle();
  const unread = chat.unreadCount;
  const lastMessage = chat.lastMessage;
  const context = [
    chat.clubName,
    ...chat.groups.map((g) => g.name),
    chat.kind === "direct" ? t("chat.directWith") : null,
  ].filter(Boolean);
  const counterpartProtected =
    chat.kind === "direct" &&
    chat.counterpart?.kind === "person" &&
    chat.counterpart.person.protected;
  return (
    <Row
      last={last ?? false}
      onPress={() => router.push(`/chats/${chat.clubId}/${chat.id}`)}
      accessibilityLabel={title(chat)}
      testID={`chat-${chat.id}`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
        <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Text
            style={{ color: theme.colors.fg, fontSize: 16, fontWeight: unread > 0 ? "700" : "500" }}
          >
            {title(chat)}
          </Text>
          {counterpartProtected ? <ProtectedBadge /> : null}
          {chat.defaultForGroupId ? <RoleBadge label={t("chat.defaultChannel")} /> : null}
          {chat.visibility === "closed" ? (
            <RoleBadge label={t("chat.visibilityShort.closed")} />
          ) : null}
          {chat.archived ? <RoleBadge label={t("chat.archived")} /> : null}
          {chat.membership?.status === "offered" ? (
            <RoleBadge tone="accent" label={t("chat.offeredStatus")} />
          ) : null}
        </View>
        {chat.lastMessageAt ? (
          <Muted>
            {format.dateTime(new Date(chat.lastMessageAt), {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </Muted>
        ) : null}
      </View>
      {showContext && context.length > 0 ? <Muted>{context.join(" · ")}</Muted> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.muted }}>
          {lastMessage
            ? lastMessage.kind === "system"
              ? ""
              : `${label(lastMessage.sender)}: ${lastMessage.excerpt || t("chat.hiddenBySender")}`
            : t("chat.noMessages")}
        </Text>
        {unread > 0 ? (
          <Text
            testID={`chat-unread-${chat.id}`}
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentFg,
              borderRadius: 10,
              overflow: "hidden",
              paddingHorizontal: 8,
              paddingVertical: 2,
              fontWeight: "600",
              fontSize: 13,
            }}
          >
            {t("chat.unread", { count: unread >= 99 ? 99 : unread })}
          </Text>
        ) : null}
      </View>
    </Row>
  );
}
