// SPDX-License-Identifier: AGPL-3.0-only
// A chat (P2.1, ADR 0047): the messages, newest at the bottom, live over the
// real-time connection; who is in it and why (openness: everyone sees it);
// the children's banner; joining (visibly), accepting or declining an
// offer, leaving and the push setting. Messages are sent through the outbox
// with an ID chosen here (UUIDv7), so they wait for coverage and a resend
// never doubles them. Cache first: cached messages show at once. People
// only as the API presented them (ADR 0022); with protected people in the
// chat, screenshots are blocked.

import { enumKey } from "@clubadmin/i18n";
import { CHAT_MESSAGE_MAX_LENGTH, type RealtimeServerEvent } from "@clubadmin/shared";
import { Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { messageId } from "../../../../api/chat-ids.ts";
import { type OutboxWrite, useOutbox, usePendingWrites } from "../../../../api/outbox.ts";
import {
  type ChatDetail,
  type ChatMessage,
  useChat,
  useChatActions,
  useChatMessages,
} from "../../../../api/queries.ts";
import { useRealtime } from "../../../../api/realtime.ts";
import { useChatPersonLabel, useChatTitle } from "../../../../components/chat-parts.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { OutboxBanner } from "../../../../components/outbox-banner.tsx";
import { useProtectScreen } from "../../../../components/protect-screen.ts";
import { RoleBadge } from "../../../../components/role-badge.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import {
  Body,
  Button,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../../components/ui.tsx";
import { useSession } from "../../../../state/session.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮"];
const PUSH = ["all", "mentions", "off"] as const;

type ChatWrite = Extract<OutboxWrite, { kind: "chatMessage" }>;
type Item = { kind: "message"; message: ChatMessage } | { kind: "pending"; write: ChatWrite };

export default function ChatScreen() {
  const clubId = useIdParam("clubId");
  const chatId = useIdParam("chatId");
  if (!clubId || !chatId) return <NotFound />;
  return <Chat clubId={clubId} chatId={chatId} />;
}

function Chat({ clubId, chatId }: { clubId: string; chatId: string }) {
  const t = useTranslations();
  const title = useChatTitle();
  const label = useChatPersonLabel();
  const { personId: me } = useSession();
  const detail = useChat(clubId, chatId);
  const [showInfo, setShowInfo] = useState(false);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const onEvent = useCallback(
    (event: RealtimeServerEvent) => {
      if (event.type === "typing" && event.chatId === chatId && event.personId !== me) {
        setTyping((current) => ({ ...current, [event.personId]: Date.now() }));
      }
    },
    [chatId, me],
  );
  const realtime = useRealtime(onEvent);
  const clearTyping = useCallback(
    () =>
      setTyping((current) => {
        const now = Date.now();
        const kept = Object.entries(current).filter(([, at]) => now - at < 4000);
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
      }),
    [],
  );
  const members = detail.data?.members ?? [];
  useProtectScreen(
    members.some((m) => m.person?.kind === "person" && m.person.person.protected) ||
      (detail.data?.hiddenMembers ?? 0) > 0,
    `chat-${chatId}`,
  );

  if (!detail.data) {
    if (detail.isError)
      return (
        <Screen>
          <ErrorView error={detail.error} onRetry={() => void detail.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const data = detail.data;
  const active = data.chat.membership?.status === "active";
  const header = (
    <Stack.Screen
      options={{
        title: title(data.chat),
        ...(active
          ? {
              headerRight: () => (
                <LinkButton
                  label={showInfo ? t("chat.cancel") : t("chat.members")}
                  onPress={() => setShowInfo((v) => !v)}
                  testID="chat-info"
                />
              ),
            }
          : {}),
      }}
    />
  );
  if (!active || showInfo) {
    return (
      <Screen
        refreshing={detail.isRefetching}
        onRefresh={() => void detail.refetch()}
        testID="chat-info-screen"
      >
        {header}
        <ChatInfo clubId={clubId} chatId={chatId} detail={data} />
      </Screen>
    );
  }
  const names: Record<string, string> = {};
  for (const m of members) if (m.personId) names[m.personId] = label(m.person);
  return (
    <>
      {header}
      <Messages
        clubId={clubId}
        chatId={chatId}
        detail={data}
        names={names}
        connected={realtime.connected}
        typing={typing}
        onTyping={() => realtime.typing(chatId)}
        clearTyping={clearTyping}
      />
    </>
  );
}

function ChatInfo({
  clubId,
  chatId,
  detail,
}: {
  clubId: string;
  chatId: string;
  detail: ChatDetail;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const label = useChatPersonLabel();
  const actions = useChatActions(clubId, chatId);
  const { chat, members } = detail;
  const status = chat.membership?.status;
  const guardiansIn = members.filter((m) => m.guardianOf.length > 0 && m.status === "active");
  const nameOf = (id: string) => label(members.find((m) => m.personId === id)?.person);
  return (
    <>
      <View style={{ gap: theme.space(1) }}>
        <Muted>{[chat.clubName, ...chat.groups.map((g) => g.name)].join(" · ")}</Muted>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
          {chat.visibility ? (
            <RoleBadge label={t(enumKey("chat.visibilityShort", chat.visibility))} />
          ) : null}
          {chat.archived ? <RoleBadge label={t("chat.archived")} /> : null}
        </View>
        {chat.description ? <Body>{chat.description}</Body> : null}
      </View>
      {chat.hasChildren ? (
        <View
          testID="chat-child-banner"
          style={{
            backgroundColor: theme.colors.accentSoft,
            borderRadius: 8,
            padding: theme.space(3),
            gap: theme.space(1),
          }}
        >
          <Body>{t("chat.childBanner")}</Body>
          <Body>
            {guardiansIn.length > 0
              ? t("chat.childBannerJoined", {
                  names: guardiansIn.map((m) => label(m.person)).join(", "),
                })
              : t("chat.childBannerNone")}
          </Body>
          <Muted>{t("chat.leaderRule")}</Muted>
        </View>
      ) : null}
      {status === "offered" ? (
        <View style={{ gap: theme.space(2) }}>
          <Body>{t("chat.offered")}</Body>
          <Button
            label={t("chat.accept")}
            busy={actions.join.isPending}
            onPress={() => actions.join.mutate()}
            testID="chat-accept"
          />
          <Button
            label={t("chat.decline")}
            kind="secondary"
            busy={actions.leave.isPending}
            onPress={() => actions.leave.mutate()}
            testID="chat-decline"
          />
        </View>
      ) : status !== "active" ? (
        <View style={{ gap: theme.space(2) }}>
          <View testID="chat-not-member">
            <Body>{t("chat.notMember")}</Body>
          </View>
          {detail.can.join ? (
            <Button
              label={t("chat.join")}
              busy={actions.join.isPending}
              onPress={() => actions.join.mutate()}
              testID="chat-join"
            />
          ) : null}
        </View>
      ) : null}
      <Section title={t("chat.members")}>
        {members.map((m, index) => (
          <Row key={m.personId ?? `hidden-${index}`} last={index === members.length - 1}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Body style={{ fontWeight: "600" }}>{label(m.person)}</Body>
              {m.child ? <RoleBadge label={t("chat.child")} /> : null}
              {m.leader ? <RoleBadge label={t("chat.leader")} /> : null}
            </View>
            <Muted>
              {m.status === "offered"
                ? t("chat.offeredStatus")
                : t(enumKey("chat.reasons", m.reason))}
              {m.guardianOf.length > 0
                ? ` · ${t("chat.guardianOf", { names: m.guardianOf.map(nameOf).join(", ") })}`
                : ""}
            </Muted>
          </Row>
        ))}
        {detail.hiddenMembers > 0 ? (
          <Muted style={{ paddingVertical: theme.space(2) }}>
            {t("chat.hiddenMembers", { count: detail.hiddenMembers })}
          </Muted>
        ) : null}
      </Section>
      {status === "active" ? (
        <>
          <Section title={t("chat.push")}>
            {PUSH.map((push, index) => (
              <Row
                key={push}
                last={index === PUSH.length - 1}
                onPress={() => actions.push.mutate(push)}
                accessibilityLabel={t(enumKey("chat.pushSettings", push))}
                testID={`chat-push-${push}`}
              >
                <Body style={{ fontWeight: chat.membership?.push === push ? "700" : "400" }}>
                  {chat.membership?.push === push ? "● " : "○ "}
                  {t(enumKey("chat.pushSettings", push))}
                </Body>
              </Row>
            ))}
          </Section>
          {detail.can.leave ? (
            <Button
              label={t("chat.leave")}
              kind="danger"
              busy={actions.leave.isPending}
              onPress={() => actions.leave.mutate()}
              testID="chat-leave"
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function Messages({
  clubId,
  chatId,
  detail,
  names,
  connected,
  typing,
  onTyping,
  clearTyping,
}: {
  clubId: string;
  chatId: string;
  detail: ChatDetail;
  names: Record<string, string>;
  connected: boolean;
  typing: Record<string, number>;
  onTyping: () => void;
  clearTyping: () => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const format = useFormatter();
  const label = useChatPersonLabel();
  const { personId: me } = useSession();
  const messages = useChatMessages(clubId, chatId, true);
  const actions = useChatActions(clubId, chatId);
  const outbox = useOutbox();
  const pendingWrites = usePendingWrites();
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const lastTyping = useRef(0);

  const loaded = useMemo(
    () => messages.data?.pages.flatMap((page) => page.items) ?? [],
    [messages.data],
  );
  const items: Item[] = useMemo(() => {
    const ids = new Set(loaded.map((m) => m.id));
    const pending = pendingWrites
      .filter((w): w is ChatWrite => w.kind === "chatMessage" && w.chatId === chatId)
      .filter((w) => !ids.has(w.messageId))
      .reverse();
    return [
      ...pending.map((write) => ({ kind: "pending" as const, write })),
      ...loaded.map((message) => ({ kind: "message" as const, message })),
    ];
  }, [loaded, pendingWrites, chatId]);

  // Read up to the newest message (the API ignores a pointer moving backwards).
  const newest = loaded[0]?.id;
  const lastRead = detail.chat.membership?.lastReadMessageId ?? null;
  const markRead = actions.read.mutate;
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (newest && newest !== lastRead && newest !== marked.current) {
      marked.current = newest;
      markRead(newest);
    }
  }, [newest, lastRead, markRead]);

  // "Typing" fades after four seconds.
  const typingIds = Object.keys(typing);
  useEffect(() => {
    if (typingIds.length === 0) return;
    const timer = setInterval(clearTyping, 1000);
    return () => clearInterval(timer);
  }, [typingIds.length, clearTyping]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    if (editing) {
      actions.edit.mutate({ messageId: editing.id, body });
      setEditing(null);
    } else {
      outbox({
        kind: "chatMessage",
        clubId,
        chatId,
        messageId: messageId(),
        body,
        replyToId: replyTo?.id ?? null,
      });
      setReplyTo(null);
    }
    setText("");
  };

  const hide = (message: ChatMessage) =>
    Alert.alert(t("chat.delete"), t("chat.deleteConfirm"), [
      { text: t("chat.cancel"), style: "cancel" },
      {
        text: t("chat.delete"),
        style: "destructive",
        onPress: () => actions.hide.mutate(message.id),
      },
    ]);

  const bubble = (mine: boolean) => ({
    alignSelf: mine ? ("flex-end" as const) : ("flex-start" as const),
    maxWidth: "85%" as const,
    backgroundColor: mine ? theme.colors.accentSoft : theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: theme.space(1),
  });

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === "pending") {
      return (
        <View style={bubble(true)} testID="chat-pending">
          <Body>{item.write.body}</Body>
          <Muted>{t("chat.sending")}</Muted>
        </View>
      );
    }
    const m = item.message;
    if (m.kind === "system") {
      const who = (m.event?.personIds ?? []).map((id) => names[id] ?? t("chat.someone"));
      return (
        <Muted style={{ textAlign: "center", paddingVertical: theme.space(1) }}>
          {m.event ? t(enumKey("chat.system", m.event.type), { names: who.join(", ") }) : ""}
        </Muted>
      );
    }
    const mine = m.senderId !== null && m.senderId === me;
    const open = selected === m.id;
    return (
      <Pressable
        onLongPress={() => setSelected(open ? null : m.id)}
        onPress={() => (open ? setSelected(null) : undefined)}
        accessibilityHint={t("chat.react")}
        style={bubble(mine)}
        testID={`chat-message-${m.id}`}
      >
        {!mine ? (
          <Text style={{ color: theme.colors.fg, fontWeight: "600" }}>{label(m.sender)}</Text>
        ) : null}
        {m.replyTo ? (
          <Muted
            style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 6 }}
          >
            {`${label(m.replyTo.sender)}: ${m.replyTo.excerpt}`}
          </Muted>
        ) : null}
        {m.hidden ? (
          <Muted style={{ fontStyle: "italic" }}>
            {m.hidden === "moderator" ? t("chat.hiddenByModerator") : t("chat.hiddenBySender")}
          </Muted>
        ) : (
          <Body>{m.body}</Body>
        )}
        <Muted style={{ fontSize: 12 }}>
          {format.dateTime(new Date(m.createdAt), { dateStyle: "short", timeStyle: "short" })}
          {m.editedAt ? ` · ${t("chat.edited")}` : ""}
        </Muted>
        {m.reactions.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {m.reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() =>
                  actions.react.mutate({ messageId: m.id, emoji: r.emoji, on: !r.mine })
                }
                accessibilityRole="button"
                style={{
                  borderWidth: 1,
                  borderColor: r.mine ? theme.colors.accent : theme.colors.border,
                  borderRadius: 10,
                  paddingHorizontal: 6,
                  minHeight: 28,
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: theme.colors.fg }}>{`${r.emoji} ${r.count}`}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {open && !m.hidden ? (
          <View style={{ gap: theme.space(1) }}>
            <View style={{ flexDirection: "row", gap: theme.space(2) }}>
              {REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("chat.react")} ${emoji}`}
                  hitSlop={6}
                  onPress={() => {
                    const mineAlready = m.reactions.some((r) => r.emoji === emoji && r.mine);
                    actions.react.mutate({ messageId: m.id, emoji, on: !mineAlready });
                    setSelected(null);
                  }}
                >
                  <Text style={{ fontSize: 22 }}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: "row", gap: theme.space(4) }}>
              {detail.can.post ? (
                <LinkButton
                  label={t("chat.reply")}
                  onPress={() => {
                    setReplyTo(m);
                    setEditing(null);
                    setSelected(null);
                  }}
                  testID="chat-reply"
                />
              ) : null}
              {mine ? (
                <LinkButton
                  label={t("chat.edit")}
                  onPress={() => {
                    setEditing(m);
                    setReplyTo(null);
                    setText(m.body);
                    setSelected(null);
                  }}
                  testID="chat-edit"
                />
              ) : null}
              {mine ? (
                <LinkButton
                  label={t("chat.delete")}
                  onPress={() => {
                    setSelected(null);
                    hide(m);
                  }}
                  testID="chat-delete"
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </Pressable>
    );
  };

  const typingNames = typingIds.map((id) => names[id] ?? t("chat.someone"));
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
    >
      <OutboxBanner />
      {!connected ? (
        <Muted style={{ paddingHorizontal: theme.space(4), paddingTop: theme.space(1) }}>
          {t("chat.offline")}
        </Muted>
      ) : null}
      {messages.isError && !messages.data ? (
        <View style={{ padding: theme.space(4) }}>
          <ErrorView error={messages.error} onRetry={() => void messages.refetch()} />
        </View>
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) =>
            item.kind === "pending" ? item.write.messageId : item.message.id
          }
          renderItem={renderItem}
          contentContainerStyle={{ padding: theme.space(4), gap: theme.space(2) }}
          onEndReached={() => {
            if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
          }}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            messages.isPending ? (
              <Loading label={t("common.loading")} />
            ) : (
              <Muted style={{ textAlign: "center" }}>{t("chat.noMessages")}</Muted>
            )
          }
          testID="chat-messages"
        />
      )}
      <Muted style={{ paddingHorizontal: theme.space(4), minHeight: 18 }}>
        {typingNames.length > 0 ? t("chat.typing", { name: typingNames.join(", ") }) : ""}
      </Muted>
      {detail.can.post ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
            padding: theme.space(3),
            gap: theme.space(2),
          }}
        >
          {replyTo || editing ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
              <Muted style={{ flex: 1 }}>
                {editing ? t("chat.edit") : t("chat.replyingTo", { name: label(replyTo?.sender) })}
              </Muted>
              <LinkButton
                label={t("chat.cancel")}
                onPress={() => {
                  setReplyTo(null);
                  if (editing) setText("");
                  setEditing(null);
                }}
                testID="chat-cancel"
              />
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: theme.space(2) }}>
            <TextInput
              value={text}
              onChangeText={(value) => {
                setText(value);
                const now = Date.now();
                if (now - lastTyping.current > 3000) {
                  lastTyping.current = now;
                  onTyping();
                }
              }}
              placeholder={t("chat.placeholder")}
              placeholderTextColor={theme.colors.muted}
              accessibilityLabel={t("chat.placeholder")}
              multiline
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              testID="chat-input"
              style={{
                flex: 1,
                minHeight: theme.touch,
                maxHeight: 140,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                paddingHorizontal: theme.space(3),
                paddingVertical: theme.space(2),
                color: theme.colors.fg,
                fontSize: 16,
              }}
            />
            <Button
              label={editing ? t("chat.save") : t("chat.send")}
              onPress={send}
              disabled={text.trim().length === 0}
              testID="chat-send"
            />
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
