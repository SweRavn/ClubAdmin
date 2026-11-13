// SPDX-License-Identifier: AGPL-3.0-only
// Server-rendered parts of the chat pages (P2.1): a chat's title, a chat
// person's label (only as the API presented them, ADR 0022), the list row of
// "Mina kanaler" and of a group's channels.
import type { ChatPerson, ChatSummary } from "@clubadmin/shared";
import { personLabel, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

/** The words for people the viewer may not see by name. */
export interface ChatLabels {
  formerMember: string;
  protectedPerson: string;
  someone: string;
}

export async function chatLabels(): Promise<ChatLabels> {
  const t = await getTranslations("chat");
  return {
    formerMember: t("formerMember"),
    protectedPerson: t("protectedPerson"),
    someone: t("someone"),
  };
}

export function chatPersonLabel(labels: ChatLabels, person: ChatPerson | null): string {
  if (person?.kind === "person") return personLabel(person.person);
  if (person?.kind === "former_member") return labels.formerMember;
  if (person?.kind === "protected") return labels.protectedPerson;
  return labels.someone;
}

export function chatTitle(labels: ChatLabels, chat: ChatSummary): string {
  if (chat.kind === "direct") return chatPersonLabel(labels, chat.counterpart);
  return chat.name ?? "";
}

export async function ChatRow({
  chat,
  showContext = true,
  timeLabel,
}: {
  chat: ChatSummary;
  showContext?: boolean;
  timeLabel?: string | null;
}) {
  const [t, labels] = await Promise.all([getTranslations(), chatLabels()]);
  const last = chat.lastMessage;
  const unread = chat.unreadCount;
  const context = [
    chat.clubName,
    ...chat.groups.map((g) => g.name),
    chat.kind === "direct" ? t("chat.directWith") : null,
  ].filter(Boolean);
  return (
    <a
      href={`/clubs/${chat.clubId}/chats/${chat.id}`}
      className="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-surface"
      data-testid="chat-row"
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={unread > 0 ? "font-semibold" : ""}>{chatTitle(labels, chat)}</span>
          {chat.defaultForGroupId ? <RoleBadge label={t("chat.defaultChannel")} /> : null}
          {chat.visibility === "closed" ? (
            <RoleBadge label={t("chat.visibilityShort.closed")} />
          ) : null}
          {chat.archived ? <RoleBadge label={t("chat.archived")} /> : null}
          {chat.membership?.status === "offered" ? (
            <RoleBadge label={t("chat.offeredStatus")} />
          ) : null}
          {chat.membership?.push === "off" ? <RoleBadge label={t("chat.pushOff")} /> : null}
        </span>
        {showContext && context.length > 0 ? (
          <span className="block text-xs text-muted">{context.join(" · ")}</span>
        ) : null}
        <span className="block truncate text-sm text-muted">
          {last
            ? last.kind === "system"
              ? ""
              : `${chatPersonLabel(labels, last.sender)}: ${last.excerpt || t("chat.hiddenBySender")}`
            : t("chat.noMessages")}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1 text-xs text-muted">
        {timeLabel ? <span>{timeLabel}</span> : null}
        {unread > 0 ? (
          <span
            className="rounded-full bg-accent px-2 py-0.5 font-semibold text-accent-fg"
            data-testid="chat-unread"
          >
            {t("chat.unread", { count: unread >= 99 ? 99 : unread })}
          </span>
        ) : null}
      </span>
    </a>
  );
}
