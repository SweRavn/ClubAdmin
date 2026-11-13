// SPDX-License-Identifier: AGPL-3.0-only
// A chat (P2.1, ADR 0047): the messages (client component, live), who is
// in it and why (everyone sees it: openness), the children's banner, and
// what the viewer may do: join (visibly), accept or decline an offer, leave,
// push setting, and for managers rename, archive and add or remove members.
import { CHAT_PUSH_SETTINGS, type ChatMember } from "@clubadmin/shared";
import { personLabel, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass as primaryButtonClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import {
  chatLabels,
  chatPersonLabel,
  chatTitle,
} from "../../../../../../components/chat-parts.tsx";
import { ChatRoom, type ChatRoomTexts } from "../../../../../../components/chat-room.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import {
  getChat,
  getChatMessages,
  getGroupMembers,
  getMe,
  requireId,
  requireSession,
} from "../../../../../../server/data.ts";

type Params = {
  params: Promise<{ clubId: string; chatId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Params) {
  const { clubId, chatId } = await params;
  const [labels, detail] = await Promise.all([
    chatLabels(),
    getChat(requireId(clubId), requireId(chatId)),
  ]);
  return { title: chatTitle(labels, detail.chat) };
}

export default async function ChatPage({ params, searchParams }: Params) {
  const { clubId: rawClub, chatId: rawChat } = await params;
  const clubId = requireId(rawClub);
  const chatId = requireId(rawChat);
  const query = (await searchParams) ?? {};
  const [t, labels, locale, timeZone, detail, me, session] = await Promise.all([
    getTranslations(),
    chatLabels(),
    getLocale(),
    getTimeZone(),
    getChat(clubId, chatId),
    getMe(),
    requireSession(),
  ]);
  const { chat, members } = detail;
  const active = chat.membership?.status === "active";
  const manageGroup =
    detail.can.manage && !chat.defaultForGroupId && chat.groups.length === 1
      ? chat.groups[0]!
      : null;
  const [page, roster] = await Promise.all([
    active ? getChatMessages(clubId, chatId, null) : null,
    manageGroup ? getGroupMembers(manageGroup.id, 200) : null,
  ]);
  const inChat = new Set(members.map((m) => m.personId));
  const addable = (roster?.items ?? []).filter((r) => !inChat.has(r.person.id));

  // Names the client shows for system messages and typing (only people the API presented).
  const names: Record<string, string> = {};
  for (const m of members) if (m.personId) names[m.personId] = chatPersonLabel(labels, m.person);
  for (const m of page?.items ?? []) {
    if (m.senderId && m.sender) names[m.senderId] = chatPersonLabel(labels, m.sender);
  }
  const readPointers: Record<string, string | null> = {};
  for (const m of members) if (m.personId) readPointers[m.personId] = m.lastReadMessageId;

  const label = (m: ChatMember) => chatPersonLabel(labels, m.person);
  const guardiansIn = members.filter((m) => m.guardianOf.length > 0 && m.status === "active");
  const texts: ChatRoomTexts = {
    placeholder: t("chat.placeholder"),
    send: t("chat.send"),
    sending: t("chat.sending"),
    failed: t("chat.failed"),
    edited: t("chat.edited"),
    hiddenBySender: t("chat.hiddenBySender"),
    hiddenByModerator: t("chat.hiddenByModerator"),
    reply: t("chat.reply"),
    replyingTo: t("chat.replyingTo", { name: "{name}" }),
    cancel: t("chat.cancel"),
    edit: t("chat.edit"),
    save: t("chat.save"),
    delete: t("chat.delete"),
    deleteConfirm: t("chat.deleteConfirm"),
    versions: t("chat.versions"),
    typing: t("chat.typing", { name: "{name}" }),
    offline: t("chat.offline"),
    loadOlder: t("chat.loadOlder"),
    readBy: t("chat.readBy", { count: 2 }).replace("2", "{count}"),
    someone: t("chat.someone"),
    protectedPerson: t("chat.protectedPerson"),
    formerMember: t("chat.formerMember"),
    noMessages: t("chat.noMessages"),
    system: Object.fromEntries(
      (
        [
          "created",
          "joined",
          "left",
          "added",
          "removed",
          "guardians_added",
          "renamed",
          "archived",
        ] as const
      ).map((k) => [k, t(`chat.system.${k}`, { names: "{names}" })]),
    ),
  };
  const back = `/clubs/${clubId}/chats/${chatId}`;
  const ids = { clubId, chatId };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <section className="min-w-0 space-y-3">
        <div>
          <p className="text-sm text-muted">
            {[chat.clubName, ...chat.groups.map((g) => g.name)].join(" · ")}
          </p>
          <h1
            className="flex flex-wrap items-center gap-2 text-2xl font-semibold"
            data-testid="chat-title"
          >
            {chatTitle(labels, chat)}
            {chat.visibility ? (
              <RoleBadge label={t(`chat.visibilityShort.${chat.visibility}`)} />
            ) : null}
            {chat.archived ? <RoleBadge label={t("chat.archived")} /> : null}
          </h1>
          {chat.description ? <p className="text-sm text-muted">{chat.description}</p> : null}
        </div>
        <FormError code={query.error} />
        {chat.hasChildren ? (
          <p
            className="rounded-md bg-accent-soft px-3 py-2 text-sm"
            data-testid="chat-child-banner"
          >
            {t("chat.childBanner")}{" "}
            {guardiansIn.length > 0
              ? t("chat.childBannerJoined", { names: guardiansIn.map(label).join(", ") })
              : t("chat.childBannerNone")}{" "}
            <span className="text-muted">{t("chat.leaderRule")}</span>
          </p>
        ) : null}
        {chat.membership?.status === "offered" ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p>{t("chat.offered")}</p>
            <div className="flex gap-2">
              <ActionForm action="join-chat" back={back}>
                <input type="hidden" name="clubId" value={clubId} />
                <input type="hidden" name="chatId" value={chatId} />
                <button type="submit" className={primaryButtonClass} data-testid="chat-accept">
                  {t("chat.accept")}
                </button>
              </ActionForm>
              <ActionForm action="leave-chat">
                <input type="hidden" name="clubId" value={clubId} />
                <input type="hidden" name="chatId" value={chatId} />
                <button type="submit" className={secondaryButtonClass}>
                  {t("chat.decline")}
                </button>
              </ActionForm>
            </div>
          </div>
        ) : null}
        {!active && chat.membership?.status !== "offered" ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p data-testid="chat-not-member">{t("chat.notMember")}</p>
            {detail.can.join ? (
              <ActionForm action="join-chat" back={back}>
                <input type="hidden" name="clubId" value={ids.clubId} />
                <input type="hidden" name="chatId" value={ids.chatId} />
                <button type="submit" className={primaryButtonClass} data-testid="chat-join">
                  {t("chat.join")}
                </button>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
        {active && page ? (
          <ChatRoom
            clubId={clubId}
            chatId={chatId}
            meId={me.personId}
            csrf={session.record.csrf}
            canPost={detail.can.post}
            initial={page.items}
            initialCursor={page.nextCursor}
            names={names}
            readPointers={readPointers}
            locale={locale}
            timeZone={timeZone}
            texts={texts}
          />
        ) : null}
      </section>

      <aside className="space-y-4">
        <section>
          <h2 className="font-semibold">{t("chat.members")}</h2>
          <ul className="mt-2 space-y-1 text-sm" data-testid="chat-members">
            {members.map((m, i) => (
              <li key={m.personId ?? `hidden-${i}`} className="flex flex-wrap items-center gap-1">
                <span>{label(m)}</span>
                {m.child ? <RoleBadge label={t("chat.child")} /> : null}
                {m.leader ? <RoleBadge label={t("chat.leader")} /> : null}
                <span className="text-xs text-muted">
                  {m.status === "offered" ? t("chat.offeredStatus") : t(`chat.reasons.${m.reason}`)}
                  {m.guardianOf.length > 0
                    ? ` · ${t("chat.guardianOf", {
                        names: m.guardianOf
                          .map((id) => label(members.find((x) => x.personId === id)!))
                          .join(", "),
                      })}`
                    : ""}
                </span>
                {detail.can.manage &&
                m.personId &&
                m.personId !== me.personId &&
                m.reason !== "guardian_auto" &&
                !chat.defaultForGroupId ? (
                  <ActionForm action="remove-chat-member" back={back} className="ml-auto">
                    <input type="hidden" name="clubId" value={clubId} />
                    <input type="hidden" name="chatId" value={chatId} />
                    <input type="hidden" name="personId" value={m.personId} />
                    <button type="submit" className="text-xs underline">
                      {t("chat.remove")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {detail.hiddenMembers > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {t("chat.hiddenMembers", { count: detail.hiddenMembers })}
            </p>
          ) : null}
        </section>

        {active ? (
          <section>
            <h2 className="font-semibold">{t("chat.push")}</h2>
            <ActionForm action="chat-settings" back={back} className="mt-2 space-y-1 text-sm">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="chatId" value={chatId} />
              {CHAT_PUSH_SETTINGS.map((p) => (
                <label key={p} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="push"
                    value={p}
                    defaultChecked={chat.membership?.push === p}
                  />
                  {t(`chat.pushSettings.${p}`)}
                </label>
              ))}
              <button type="submit" className={secondaryButtonClass}>
                {t("chat.save")}
              </button>
            </ActionForm>
          </section>
        ) : null}

        {detail.can.manage && !chat.defaultForGroupId ? (
          <section className="space-y-2">
            <h2 className="font-semibold">{t("chat.manage")}</h2>
            <ActionForm action="update-chat" back={back} className="flex gap-2">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="chatId" value={chatId} />
              <input
                name="name"
                defaultValue={chat.name ?? ""}
                aria-label={t("chat.name")}
                maxLength={80}
                className="min-w-0 flex-1 rounded-md border border-border px-2 py-1"
              />
              <button type="submit" className={secondaryButtonClass}>
                {t("chat.rename")}
              </button>
            </ActionForm>
            {addable.length > 0 ? (
              <ActionForm action="add-chat-members" back={back} className="space-y-1 text-sm">
                <input type="hidden" name="clubId" value={clubId} />
                <input type="hidden" name="chatId" value={chatId} />
                <fieldset className="max-h-48 space-y-1 overflow-y-auto">
                  <legend className="font-medium">{t("chat.addMembers")}</legend>
                  {addable.map((r) => (
                    <label key={r.person.id} className="flex items-center gap-2">
                      <input type="checkbox" name="memberId" value={r.person.id} />
                      {personLabel(r.person)}
                    </label>
                  ))}
                </fieldset>
                <button type="submit" className={secondaryButtonClass}>
                  {t("chat.addMembers")}
                </button>
              </ActionForm>
            ) : null}
            <ActionForm action="update-chat" back={back}>
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="chatId" value={chatId} />
              <input type="hidden" name="archived" value={chat.archived ? "false" : "true"} />
              <button type="submit" className={secondaryButtonClass}>
                {chat.archived ? t("chat.unarchive") : t("chat.archive")}
              </button>
            </ActionForm>
          </section>
        ) : null}

        {detail.can.leave ? (
          <ActionForm action="leave-chat">
            <input type="hidden" name="clubId" value={clubId} />
            <input type="hidden" name="chatId" value={chatId} />
            <button type="submit" className={secondaryButtonClass} data-testid="chat-leave">
              {t("chat.leave")}
            </button>
          </ActionForm>
        ) : null}
      </aside>
    </div>
  );
}
