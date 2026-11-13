// SPDX-License-Identifier: AGPL-3.0-only
// Chat rows as API responses (P2.1). People become output only through the
// PersonPresenter (ADR 0022): someone the viewer may not see is "protected",
// an erased person "former_member" (ADR 0047: the text stays, the author is
// anonymised).

import type {
  ChatMember,
  ChatMessage,
  ChatPerson,
  ChatSummary,
  PersonSummary,
} from "@clubadmin/shared";

import type { PersonPresenter, RequestAuthorization } from "../authorization/index.ts";
import type { PeopleService } from "../people/index.ts";
import type {
  ChatListRow,
  ChatMemberView,
  ChatNames,
  MessagePage,
  MessageRow,
} from "./chat.service.ts";

const EXCERPT = 140;
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
const excerpt = (m: MessageRow) =>
  m.kind === "text" && !m.hiddenAt ? m.body.slice(0, EXCERPT) : "";

/** People of one club as the viewer may see them. */
export class ChatPeople {
  private readonly shown: Map<string, PersonSummary>;
  private readonly erased: Set<string>;

  constructor(shown: Map<string, PersonSummary>, erased: Set<string>) {
    this.shown = shown;
    this.erased = erased;
  }

  static async load(
    people: PeopleService,
    presenter: PersonPresenter,
    authz: RequestAuthorization,
    byClub: Map<string, Set<string>>,
  ): Promise<Map<string, ChatPeople>> {
    const all = [...new Set([...byClub.values()].flatMap((s) => [...s]))];
    const rows = all.length ? await people.chatPeople(all) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const result = new Map<string, ChatPeople>();
    for (const [clubId, ids] of byClub) {
      const list = [...ids].map((id) => byId.get(id)).filter((r) => r !== undefined);
      const erased = new Set(list.filter((r) => r.erased).map((r) => r.id));
      const visible = await presenter.present(
        authz,
        clubId,
        list.filter((r) => !r.erased),
      );
      result.set(clubId, new ChatPeople(new Map(visible.map((p) => [p.id, p])), erased));
    }
    return result;
  }

  person(id: string | null): ChatPerson | null {
    if (id === null) return null;
    if (this.erased.has(id)) return { kind: "former_member" };
    const person = this.shown.get(id);
    return person ? { kind: "person", person } : { kind: "protected" };
  }

  /** The ID when the viewer may see the person (else null). */
  visibleId(id: string): string | null {
    return this.shown.has(id) ? id : null;
  }
}

/** The people a list of chats mentions, per club (counterparts, latest senders). */
export function peopleOfList(rows: readonly ChatListRow[]): Map<string, Set<string>> {
  const byClub = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byClub.get(r.chat.clubId) ?? new Set<string>();
    if (r.counterpartId) set.add(r.counterpartId);
    if (r.lastMessage?.senderPersonId) set.add(r.lastMessage.senderPersonId);
    byClub.set(r.chat.clubId, set);
  }
  return byClub;
}

export function toChatSummary(
  row: ChatListRow,
  names: ChatNames,
  people: ChatPeople | undefined,
): ChatSummary {
  const { chat } = row;
  const last = row.lastMessage;
  return {
    id: chat.id,
    clubId: chat.clubId,
    clubName: names.clubs.get(chat.clubId) ?? "",
    kind: chat.kind,
    name: chat.name,
    description: chat.description,
    visibility: chat.visibility,
    groups: row.groupIds.map((id) => ({ id, name: names.groups.get(id) ?? "" })),
    defaultForGroupId: chat.defaultForGroupId,
    archived: chat.archivedAt !== null,
    counterpart: people?.person(row.counterpartId) ?? null,
    membership: row.membership,
    memberCount: row.memberCount,
    hasChildren: chat.hasChildren,
    unreadCount: row.unreadCount,
    lastMessage: last
      ? {
          id: last.id,
          sender: people?.person(last.senderPersonId) ?? null,
          kind: last.kind,
          excerpt: excerpt(last),
          createdAt: iso(last.createdAt),
        }
      : null,
    lastMessageAt: isoOrNull(chat.lastMessageAt),
  };
}

export function toChatMembers(
  members: readonly ChatMemberView[],
  people: ChatPeople,
): { members: ChatMember[]; hidden: number } {
  const result: ChatMember[] = [];
  let hidden = 0;
  for (const m of members) {
    const person = people.person(m.personId)!;
    // An offered protected person the viewer cannot see is not shown at all.
    if (m.status === "offered" && person.kind === "protected") {
      hidden++;
      continue;
    }
    result.push({
      personId: people.visibleId(m.personId),
      person,
      status: m.status,
      reason: m.reason,
      role: m.role,
      child: m.child,
      leader: m.leader,
      guardianOf: m.guardianOf.map((id) => people.visibleId(id)).filter((id) => id !== null),
      joinedAt: iso(m.joinedAt),
      lastReadMessageId: m.lastReadMessageId,
    });
  }
  return { members: result, hidden };
}

export function toChatMessage(
  m: MessageRow,
  page: Pick<MessagePage, "replies" | "reactions">,
  people: ChatPeople,
): ChatMessage {
  const reply = m.replyToMessageId ? page.replies.get(m.replyToMessageId) : undefined;
  return {
    id: m.id,
    chatId: m.chatId,
    kind: m.kind,
    sender: people.person(m.senderPersonId),
    senderId: m.senderPersonId ? people.visibleId(m.senderPersonId) : null,
    body: m.hiddenAt ? "" : m.body,
    event: m.event
      ? {
          type: m.event.type,
          personIds: m.event.personIds
            .map((id) => people.visibleId(id))
            .filter((id): id is string => id !== null),
        }
      : null,
    replyTo: reply
      ? { id: reply.id, sender: people.person(reply.senderPersonId), excerpt: excerpt(reply) }
      : null,
    createdAt: iso(m.createdAt),
    editedAt: isoOrNull(m.editedAt),
    hidden: m.hiddenAt ? (m.hiddenReason ?? "sender") : null,
    reactions: page.reactions.get(m.id) ?? [],
  };
}

/** Everyone a page of messages mentions (senders, replied-to senders, system events). */
export function peopleOfMessages(page: Pick<MessagePage, "items" | "replies">): Set<string> {
  const ids = new Set<string>();
  for (const m of [...page.items, ...page.replies.values()]) {
    if (m.senderPersonId) ids.add(m.senderPersonId);
    for (const id of m.event?.personIds ?? []) ids.add(id);
  }
  return ids;
}
