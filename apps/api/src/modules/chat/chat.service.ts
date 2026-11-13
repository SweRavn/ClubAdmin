// SPDX-License-Identifier: AGPL-3.0-only
// Chat (P2.1, ADR 0016, ADR 0047): channels in groups and the club, direct
// messages, members, messages with every edit kept, reactions and read
// receipts. The endpoint's policy decided who may ask (authorization
// module); this service applies the rules about whom: who may be added, the
// direct-message rules and the guardian rule (app.chat_* in SQL), protected
// identity (offered, never added: ADR 0022), and that nothing disappears.
// Real-time events (IDs only) are published after the transaction commits.

import {
  type ActorContext,
  audit,
  type Database,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  CHAT_CLIENT_ID_MAX_SKEW_MS,
  type ChatMemberReason,
  type ChatPushSetting,
  type ChatSystemEvent,
  type CreateChannelInput,
  type UpdateChatInput,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import type { ChatResource } from "../authorization/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { RealtimePublisher } from "../realtime/index.ts";
import * as repo from "./chat.repository.ts";
import { activeMute } from "./safeguarding.repository.ts";

export type ChatListRow = repo.ChatListRow;
export type ChatMemberView = Awaited<ReturnType<typeof repo.members>>[number];
export type MessageRow = repo.MessageRow;

/** Names of the clubs and groups of listed chats (not personal data). */
export interface ChatNames {
  clubs: Map<string, string>;
  groups: Map<string, string>;
}

/** A page of messages with what the response needs besides the rows. */
export interface MessagePage {
  items: MessageRow[];
  replies: Map<string, MessageRow>;
  reactions: Map<string, { emoji: string; count: number; mine: boolean }[]>;
  nextCursor: string | null;
}

/** What happened in a transaction, published after it committed. */
interface Effects {
  chatId: string;
  clubId: string;
  /** People whose list of chats changed (added, removed, offered). */
  people: Set<string>;
  chatUpdated: boolean;
  messages: { id: string; created: boolean }[];
}

const effects = (clubId: string, chatId: string): Effects => ({
  chatId,
  clubId,
  people: new Set(),
  chatUpdated: false,
  messages: [],
});

/** The UUIDv7 timestamp (ms) of an ID, or null for another version. */
export function uuidv7Time(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}

/**
 * ADR 0047 rule 9: where the club requires a background check, a leader
 * writes to children and joins children's chats only with a valid one.
 * Until background checks are tracked (P2.8) the hook allows.
 */
export function backgroundCheckAllows(_clubId: string, _personId: string): boolean {
  return true;
}

export class ChatService {
  private readonly db: Database;
  private readonly publisher: RealtimePublisher;
  private readonly clubs: ClubsService;
  private readonly groups: GroupsService;

  constructor(
    db: Database,
    deps: { publisher: RealtimePublisher; clubs: ClubsService; groups: GroupsService },
  ) {
    this.db = db;
    this.publisher = deps.publisher;
    this.clubs = deps.clubs;
    this.groups = deps.groups;
  }

  /** A muted member writes nothing in the club's chats (P2.1 part B). */
  private async refuseMuted(tx: Tx, clubId: string, personId: string): Promise<void> {
    if (await activeMute(tx, clubId, personId)) throw new DomainError("chat_muted");
  }

  private async namesInTx(tx: Tx, rows: readonly ChatListRow[]): Promise<ChatNames> {
    const clubIds = [...new Set(rows.map((r) => r.chat.clubId))];
    const groupIds = [...new Set(rows.flatMap((r) => r.groupIds))];
    const [clubs, groups] = await Promise.all([
      clubIds.length ? this.clubs.findClubsInTx(tx, clubIds) : [],
      groupIds.length ? this.groups.findGroupsInTx(tx, groupIds) : [],
    ]);
    return {
      clubs: new Map(clubs.map((c) => [c.id, c.name])),
      groups: new Map(groups.map((g) => [g.id, g.name])),
    };
  }

  // --- Reads -------------------------------------------------------------------------

  /**
   * "Mina kanaler": the caller's chats across clubs, newest activity first.
   * One transaction finds the page (own memberships), then one per club of
   * the page reads its chats' columns (a person is in few clubs).
   */
  async myChats(
    context: ActorContext,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ rows: ChatListRow[]; nextCursor: string | null; names: ChatNames }> {
    const personId = actorPersonId(context);
    const found = await this.db.withActor(context, (tx) =>
      repo.myChatPage(tx, personId, { cursor: page.cursor ?? null, limit: page.limit + 1 }),
    );
    if (!found.cursorFound) throw new DomainError("invalid_cursor");
    const items = found.rows.slice(0, page.limit);
    const byClub = new Map<string, string[]>();
    for (const r of items) byClub.set(r.clubId, [...(byClub.get(r.clubId) ?? []), r.chatId]);
    const rows = new Map<string, ChatListRow>();
    const names: ChatNames = { clubs: new Map(), groups: new Map() };
    for (const [clubId, chatIds] of byClub) {
      await this.db.withTenant({ ...context, clubId }, async (tx) => {
        const list = await repo.chatListRows(tx, chatIds, personId);
        for (const r of list) rows.set(r.chat.id, r);
        const n = await this.namesInTx(tx, list);
        for (const [k, v] of n.clubs) names.clubs.set(k, v);
        for (const [k, v] of n.groups) names.groups.set(k, v);
      });
    }
    return {
      rows: items.map((r) => rows.get(r.chatId)).filter((r): r is ChatListRow => !!r),
      nextCursor: found.rows.length > page.limit ? items.at(-1)!.chatId : null,
      names,
    };
  }

  /**
   * A ward's chats for their full guardian (ADR 0047 rule 6): which chats
   * the child is in and who is in them, never the messages. The guardian's
   * own membership and unread count come with each (they may join).
   */
  async wardChats(
    context: ActorContext,
    wardId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ rows: ChatListRow[]; nextCursor: string | null; names: ChatNames }> {
    const personId = actorPersonId(context);
    const found = await this.db.withActor(context, async (tx) => {
      if (!(await repo.isWardOf(tx, wardId))) throw new DomainError("not_found");
      return repo.myChatPage(tx, wardId, { cursor: page.cursor ?? null, limit: page.limit + 1 });
    });
    if (!found.cursorFound) throw new DomainError("invalid_cursor");
    const items = found.rows.slice(0, page.limit);
    const byClub = new Map<string, string[]>();
    for (const r of items) byClub.set(r.clubId, [...(byClub.get(r.clubId) ?? []), r.chatId]);
    const rows = new Map<string, ChatListRow>();
    const names: ChatNames = { clubs: new Map(), groups: new Map() };
    for (const [clubId, chatIds] of byClub) {
      await this.db.withTenant({ ...context, clubId }, async (tx) => {
        const list = await repo.chatListRows(tx, chatIds, personId);
        for (const r of list) rows.set(r.chat.id, r);
        const n = await this.namesInTx(tx, list);
        for (const [k, v] of n.clubs) names.clubs.set(k, v);
        for (const [k, v] of n.groups) names.groups.set(k, v);
      });
    }
    return {
      rows: items.map((r) => rows.get(r.chatId)).filter((r): r is ChatListRow => !!r),
      nextCursor: found.rows.length > page.limit ? items.at(-1)!.chatId : null,
      names,
    };
  }

  /**
   * A group's chats with the caller's membership (the controller filters
   * them by policy). The group's default channel is created on first use;
   * its members follow the group through the worker.
   */
  groupChats(
    context: TenantContext,
    groupId: string,
  ): Promise<{ rows: ChatListRow[]; names: ChatNames }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await repo.ensureGroupChannel(tx, groupId);
      const rows = await repo.groupChats(tx, groupId, personId);
      return { rows, names: await this.namesInTx(tx, rows) };
    });
  }

  clubChannels(context: TenantContext): Promise<{ rows: ChatListRow[]; names: ChatNames }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.clubChannels(tx, context.clubId, personId);
      return { rows, names: await this.namesInTx(tx, rows) };
    });
  }

  /** A chat with its members (not those who left). */
  detail(
    context: TenantContext,
    chatId: string,
  ): Promise<{ row: ChatListRow; members: ChatMemberView[]; names: ChatNames }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.chatListRow(tx, chatId, personId);
      if (!row) throw new DomainError("not_found");
      return {
        row,
        members: await repo.members(tx, chatId),
        names: await this.namesInTx(tx, [row]),
      };
    });
  }

  /** The chats the person is in (active or offered), for the real-time connection. */
  chatIdsOfPerson(
    personId: string,
  ): Promise<{ chatId: string; clubId: string; status: "active" | "offered" | "left" }[]> {
    return this.db.withActor({ actorKind: "person", personId }, (tx) =>
      repo.chatIdsOfPerson(tx, personId),
    );
  }

  /** Messages for active members (the policy lets others see who is in the chat, not what was said). */
  messages(
    context: TenantContext,
    chat: ChatResource,
    query: { cursor?: string | undefined; after?: string | undefined; limit: number },
  ): Promise<MessagePage> {
    const personId = actorPersonId(context);
    if (chat.membership !== "active") throw new DomainError("chat_not_a_member");
    if (query.cursor && query.after) throw new DomainError("invalid_input");
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.messages(tx, chat.chatId, {
        cursor: query.cursor ?? null,
        after: query.after ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const replyIds = [
        ...new Set(items.map((m) => m.replyToMessageId).filter((id): id is string => !!id)),
      ];
      const replies = new Map(
        (await repo.findMessages(tx, replyIds))
          .filter((m) => m.chatId === chat.chatId)
          .map((m) => [m.id, m]),
      );
      return {
        items,
        replies,
        reactions: await repo.reactions(
          tx,
          items.map((m) => m.id),
          personId,
        ),
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** Earlier texts of an edited message (members only; hidden messages show none). */
  versions(
    context: TenantContext,
    chat: ChatResource,
    messageId: string,
  ): Promise<{ body: string; writtenAt: Date }[]> {
    if (chat.membership !== "active") throw new DomainError("chat_not_a_member");
    return this.db.withTenant(context, async (tx) => {
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId) throw new DomainError("not_found");
      if (message.hiddenAt) return [];
      return repo.versions(tx, messageId);
    });
  }

  // --- Chats and members ---------------------------------------------------------------

  /**
   * A channel in a group (groupId) or the club (no groupId). The creator is
   * its owner; the people asked for must be addable (app.chat_unaddable);
   * protected people are offered; then the guardian rule.
   */
  async createChannel(
    context: TenantContext,
    input: CreateChannelInput & { groupId: string | null },
  ): Promise<string> {
    const personId = actorPersonId(context);
    if (input.everyone && (!input.groupId || input.visibility !== "open")) {
      throw new DomainError("invalid_input");
    }
    const fx = await this.db.withTenant(context, async (tx) => {
      const chat = await repo.insertChat(
        tx,
        {
          clubId: context.clubId,
          kind: "channel",
          name: input.name,
          description: input.description ?? null,
          visibility: input.visibility,
          createdByPersonId: personId,
        },
        input.groupId ? [input.groupId] : [],
      );
      const fx = effects(context.clubId, chat.id);
      await repo.upsertMembers(
        tx,
        context.clubId,
        chat.id,
        [{ personId, status: "active", reason: "creator", role: "owner" }],
        personId,
      );
      fx.people.add(personId);
      let ids = input.memberIds.filter((id) => id !== personId);
      if (input.everyone && input.groupId) {
        ids = [...new Set([...ids, ...(await this.groupPeopleInTx(tx, input.groupId))])].filter(
          (id) => id !== personId,
        );
      }
      await this.addInTx(tx, context, chat.id, personId, ids, "added", fx, { quiet: true });
      await repo.systemMessage(tx, context.clubId, chat.id, "created", [personId]);
      await audit.record(tx, {
        action: "chat.created",
        resourceType: "chat",
        resourceId: chat.id,
        changedFields: ["name", "visibility", "members"],
      });
      await this.enforceInTx(tx, chat.id, fx);
      return fx;
    });
    await this.publish(fx);
    return fx.chatId;
  }

  /** People of a group now (any role), for "everyone in the group". */
  private async groupPeopleInTx(tx: Tx, groupId: string): Promise<string[]> {
    const chatId = await repo.syncGroup(tx, groupId);
    return chatId ? repo.activeMemberIds(tx, chatId) : [];
  }

  /**
   * The direct chat with a person: the existing one, or a new one if the
   * rules allow (ADR 0047 rules 3–5, app.chat_direct_refusal); the guardian
   * rule then adds the child's guardians.
   */
  async openDirect(context: TenantContext, otherId: string): Promise<string> {
    const personId = actorPersonId(context);
    if (otherId === personId) throw new DomainError("chat_self");
    if (!backgroundCheckAllows(context.clubId, personId)) {
      throw new DomainError("chat_background_check");
    }
    const fx = await this.db.withTenant(context, async (tx) => {
      const existing = await repo.findDirect(tx, personId, otherId);
      if (existing) {
        const me = await repo.findMember(tx, existing.id, personId);
        if (me && me.status !== "left") return effects(context.clubId, existing.id);
      }
      const refusal = await repo.directRefusal(tx, personId, otherId);
      if (refusal) {
        throw new DomainError(
          refusal === "chat_self" || refusal === "chat_not_in_club"
            ? refusal
            : "chat_child_protected",
        );
      }
      if (existing) {
        // The caller left (or was erased and is back): they return to the same conversation.
        const fx = effects(context.clubId, existing.id);
        await repo.upsertMembers(
          tx,
          context.clubId,
          existing.id,
          [{ personId, status: "active", reason: "creator", role: "owner" }],
          personId,
        );
        fx.people.add(personId);
        await this.enforceInTx(tx, existing.id, fx);
        return fx;
      }
      const chat = await repo.insertChat(
        tx,
        { clubId: context.clubId, kind: "direct", createdByPersonId: personId },
        [],
      );
      const fx = effects(context.clubId, chat.id);
      const offered = await repo.protectedAmong(tx, context.clubId, [otherId]);
      await repo.upsertMembers(
        tx,
        context.clubId,
        chat.id,
        [
          { personId, status: "active", reason: "creator", role: "owner" },
          {
            personId: otherId,
            status: offered.has(otherId) ? "offered" : "active",
            reason: "added",
          },
        ],
        personId,
      );
      fx.people.add(personId).add(otherId);
      await audit.record(tx, {
        action: "chat.created",
        resourceType: "chat",
        resourceId: chat.id,
        changedFields: ["members"],
      });
      await this.enforceInTx(tx, chat.id, fx);
      return fx;
    });
    await this.publish(fx);
    return fx.chatId;
  }

  async update(context: TenantContext, chat: ChatResource, input: UpdateChatInput): Promise<void> {
    if (
      chat.defaultForGroupId &&
      (input.archived !== undefined || input.visibility || input.name)
    ) {
      // The group's channel follows the group (its name, its archiving).
      throw new DomainError("chat_default_channel");
    }
    const personId = actorPersonId(context);
    const fx = await this.db.withTenant(context, async (tx) => {
      const row = await repo.lockChat(tx, chat.chatId);
      if (!row) throw new DomainError("not_found");
      const fx = effects(context.clubId, chat.chatId);
      const values: Parameters<typeof repo.updateChat>[2] = {};
      const changed: string[] = [];
      if (input.name !== undefined && input.name !== row.name) {
        values.name = input.name;
        changed.push("name");
      }
      if (input.description !== undefined && input.description !== row.description) {
        values.description = input.description;
        changed.push("description");
      }
      if (input.visibility !== undefined && input.visibility !== row.visibility) {
        values.visibility = input.visibility;
        changed.push("visibility");
      }
      if (input.archived !== undefined && input.archived !== (row.archivedAt !== null)) {
        values.archivedAt = input.archived ? new Date() : null;
        values.archivedByPersonId = input.archived ? personId : null;
        changed.push("archived_at");
      }
      if (changed.length === 0) return fx;
      await repo.updateChat(tx, chat.chatId, values);
      if (values.name)
        await repo.systemMessage(tx, context.clubId, chat.chatId, "renamed", [personId]);
      if (input.archived) {
        await repo.systemMessage(tx, context.clubId, chat.chatId, "archived", [personId]);
      }
      await audit.record(tx, {
        action: input.archived ? "chat.archived" : "chat.updated",
        resourceType: "chat",
        resourceId: chat.chatId,
        changedFields: changed,
      });
      fx.chatUpdated = true;
      for (const id of await repo.activeMemberIds(tx, chat.chatId)) fx.people.add(id);
      return fx;
    });
    await this.publish(fx);
  }

  /** Adds people to a channel (its managers). */
  async addMembers(context: TenantContext, chat: ChatResource, personIds: string[]): Promise<void> {
    if (chat.chatKind === "direct") throw new DomainError("chat_direct_members");
    if (chat.defaultForGroupId) throw new DomainError("chat_default_channel");
    const personId = actorPersonId(context);
    const fx = await this.db.withTenant(context, async (tx) => {
      const fx = effects(context.clubId, chat.chatId);
      await this.addInTx(tx, context, chat.chatId, personId, personIds, "added", fx);
      await this.enforceInTx(tx, chat.chatId, fx);
      return fx;
    });
    await this.publish(fx);
  }

  /**
   * Adds the people (refusing anyone not addable): protected people are
   * offered (ADR 0022). Records the system message and audit events.
   */
  private async addInTx(
    tx: Tx,
    context: TenantContext,
    chatId: string,
    by: string,
    personIds: readonly string[],
    reason: ChatMemberReason,
    fx: Effects,
    options: { quiet?: boolean } = {},
  ): Promise<void> {
    const ids = [...new Set(personIds)];
    if (ids.length === 0) return;
    const refused = await repo.unaddable(tx, chatId, by, ids);
    if (refused.length > 0) throw new DomainError("chat_member_not_allowed");
    const offered = await repo.protectedAmong(tx, context.clubId, ids);
    const changed = await repo.upsertMembers(
      tx,
      context.clubId,
      chatId,
      ids.map((id) => ({ personId: id, status: offered.has(id) ? "offered" : "active", reason })),
      by,
    );
    for (const c of changed) fx.people.add(c.personId);
    const added = changed.filter((c) => c.status === "active").map((c) => c.personId);
    if (added.length > 0 && !options.quiet) {
      await repo.systemMessage(tx, context.clubId, chatId, "added", added);
    }
    for (const c of changed) {
      await audit.record(tx, {
        action: "chat.member.added",
        resourceType: "chat",
        resourceId: chatId,
        changedFields: [c.status === "offered" ? "offered" : "member"],
      });
    }
    fx.chatUpdated ||= changed.length > 0;
  }

  /** Removes someone from a channel (its managers); not from the group's channel or a required guardian. */
  async removeMember(context: TenantContext, chat: ChatResource, personId: string): Promise<void> {
    if (chat.chatKind === "direct") throw new DomainError("chat_direct_members");
    if (chat.defaultForGroupId) throw new DomainError("chat_default_channel");
    const by = actorPersonId(context);
    if (by === personId) throw new DomainError("invalid_input");
    const fx = await this.db.withTenant(context, async (tx) => {
      const member = await repo.findMember(tx, chat.chatId, personId);
      if (!member || member.status === "left") throw new DomainError("not_found");
      if (member.reason === "guardian_auto" && member.status === "active") {
        throw new DomainError("chat_guardian_required");
      }
      const fx = effects(context.clubId, chat.chatId);
      await repo.setMemberStatus(tx, chat.chatId, personId, {
        status: "left",
        removedByPersonId: by,
      });
      fx.people.add(personId);
      if (member.status === "active") {
        await repo.systemMessage(tx, context.clubId, chat.chatId, "removed", [personId]);
      }
      await audit.record(tx, {
        action: "chat.member.removed",
        resourceType: "chat",
        resourceId: chat.chatId,
        changedFields: ["status"],
      });
      fx.chatUpdated = true;
      await this.enforceInTx(tx, chat.chatId, fx);
      return fx;
    });
    await this.publish(fx);
  }

  /**
   * Joins a chat the policy allows (an open channel, a guardian's child's
   * chat, a leader's children's chat), or accepts an offer. The reason says
   * why, for everyone in the chat; then the guardian rule.
   */
  async join(
    context: TenantContext,
    chat: ChatResource,
    as: "guardian" | "leader" | "self",
  ): Promise<void> {
    const personId = actorPersonId(context);
    if (as === "leader" && !backgroundCheckAllows(context.clubId, personId)) {
      throw new DomainError("chat_background_check");
    }
    const fx = await this.db.withTenant(context, async (tx) => {
      const fx = effects(context.clubId, chat.chatId);
      const member = await repo.findMember(tx, chat.chatId, personId);
      if (member?.status === "active") return fx;
      if (member?.status === "offered") {
        await repo.setMemberStatus(tx, chat.chatId, personId, { status: "active" });
        await audit.record(tx, {
          action: "chat.member.accepted",
          resourceType: "chat",
          resourceId: chat.chatId,
          changedFields: ["status"],
        });
      } else {
        const reason: ChatMemberReason =
          as === "guardian" ? "guardian_joined" : as === "leader" ? "leader_joined" : "joined";
        await repo.upsertMembers(
          tx,
          context.clubId,
          chat.chatId,
          [{ personId, status: "active", reason }],
          personId,
        );
        await audit.record(tx, {
          action: "chat.member.joined",
          resourceType: "chat",
          resourceId: chat.chatId,
          changedFields: [reason],
        });
      }
      await repo.systemMessage(tx, context.clubId, chat.chatId, "joined", [personId]);
      fx.people.add(personId);
      fx.chatUpdated = true;
      await this.enforceInTx(tx, chat.chatId, fx);
      return fx;
    });
    await this.publish(fx);
  }

  /**
   * Leaves a chat, or declines an offer (not offered again, ADR 0022). The
   * group's channel is left by leaving the group; direct messages stay;
   * guardians the rule requires stay (they can turn push off).
   */
  async leave(context: TenantContext, chat: ChatResource): Promise<void> {
    const personId = actorPersonId(context);
    const fx = await this.db.withTenant(context, async (tx) => {
      const member = await repo.findMember(tx, chat.chatId, personId);
      if (!member || member.status === "left") throw new DomainError("chat_not_a_member");
      const declining = member.status === "offered";
      if (!declining) {
        if (chat.chatKind === "direct") throw new DomainError("chat_direct_members");
        if (chat.defaultForGroupId) throw new DomainError("chat_default_channel");
        if (member.reason === "guardian_auto") throw new DomainError("chat_guardian_required");
      }
      const fx = effects(context.clubId, chat.chatId);
      await repo.setMemberStatus(tx, chat.chatId, personId, {
        status: "left",
        removedByPersonId: personId,
      });
      if (!declining) {
        await repo.systemMessage(tx, context.clubId, chat.chatId, "left", [personId]);
      }
      await audit.record(tx, {
        action: declining ? "chat.member.declined" : "chat.member.left",
        resourceType: "chat",
        resourceId: chat.chatId,
        changedFields: ["status"],
      });
      fx.people.add(personId);
      fx.chatUpdated = true;
      await this.enforceInTx(tx, chat.chatId, fx);
      return fx;
    });
    await this.publish(fx);
  }

  async setPush(context: TenantContext, chat: ChatResource, push: ChatPushSetting): Promise<void> {
    const personId = actorPersonId(context);
    if (chat.membership === null) throw new DomainError("chat_not_a_member");
    await this.db.withTenant(context, async (tx) => {
      await repo.setPush(tx, chat.chatId, personId, push);
    });
  }

  /** Runs the guardian rule; added guardians see the chat (and its whole history). */
  private async enforceInTx(tx: Tx, chatId: string, fx: Effects): Promise<void> {
    for (const change of await repo.enforceGuardians(tx, chatId)) {
      fx.people.add(change.personId);
      fx.chatUpdated = true;
      await audit.record(tx, {
        action: change.change === "removed" ? "chat.member.removed" : "chat.member.added",
        resourceType: "chat",
        resourceId: chatId,
        changedFields: ["guardian_auto"],
      });
    }
  }

  // --- Messages ------------------------------------------------------------------------

  async send(
    context: TenantContext,
    chat: ChatResource,
    input: { id?: string | undefined; body: string; replyToId?: string | null | undefined },
  ): Promise<MessageRow> {
    const personId = actorPersonId(context);
    if (input.id) {
      const at = uuidv7Time(input.id);
      if (at === null || Math.abs(at - Date.now()) > CHAT_CLIENT_ID_MAX_SKEW_MS) {
        throw new DomainError("invalid_input");
      }
    }
    const result = await this.db.withTenant(context, async (tx) => {
      await this.refuseMuted(tx, context.clubId, personId);
      if (input.replyToId) {
        const target = await repo.findMessage(tx, input.replyToId);
        if (!target || target.chatId !== chat.chatId) throw new DomainError("invalid_input");
      }
      const { message, created } = await repo.insertMessage(tx, {
        ...(input.id ? { id: input.id } : {}),
        clubId: context.clubId,
        chatId: chat.chatId,
        senderPersonId: personId,
        kind: "text",
        body: input.body,
        replyToMessageId: input.replyToId ?? null,
      });
      // A resent message with someone else's ID (or another chat's) is refused.
      if (!created && (message.senderPersonId !== personId || message.chatId !== chat.chatId)) {
        throw new DomainError("chat_message_conflict");
      }
      if (created) await repo.markRead(tx, chat.chatId, personId, message.id);
      return { message, created };
    });
    if (result.created) {
      await this.publisher.toChat(chat.chatId, {
        type: "message.created",
        clubId: context.clubId,
        chatId: chat.chatId,
        messageId: result.message.id,
      });
    }
    return result.message;
  }

  /** Edits one's own message; the earlier text is kept (ADR 0047). */
  async edit(
    context: TenantContext,
    chat: ChatResource,
    messageId: string,
    body: string,
  ): Promise<MessageRow> {
    const personId = actorPersonId(context);
    const message = await this.db.withTenant(context, async (tx) => {
      await this.refuseMuted(tx, context.clubId, personId);
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId) throw new DomainError("not_found");
      if (message.senderPersonId !== personId || message.kind !== "text") {
        throw new DomainError("not_allowed");
      }
      if (message.hiddenAt) throw new DomainError("chat_message_hidden");
      if (message.body === body) return message;
      return repo.editMessage(tx, message, body);
    });
    await this.publisher.toChat(chat.chatId, {
      type: "message.updated",
      clubId: context.clubId,
      chatId: chat.chatId,
      messageId,
    });
    return message;
  }

  /** Hides one's own message (deleting it): the text is kept, not shown (ADR 0047). */
  async hide(context: TenantContext, chat: ChatResource, messageId: string): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId) throw new DomainError("not_found");
      if (message.senderPersonId !== personId || message.kind !== "text") {
        throw new DomainError("not_allowed");
      }
      if (message.hiddenAt) return;
      await repo.hideMessage(tx, messageId, personId, "sender");
      await audit.record(tx, {
        action: "chat.message.hidden",
        resourceType: "chat_message",
        resourceId: messageId,
        changedFields: ["hidden_at"],
      });
    });
    await this.publisher.toChat(chat.chatId, {
      type: "message.updated",
      clubId: context.clubId,
      chatId: chat.chatId,
      messageId,
    });
  }

  /**
   * A chat's managers (its creator, `group.channels.manage`) hide a message
   * in it (ADR 0047 rule 11): kept, not shown; the sender is told.
   */
  async moderate(context: TenantContext, chat: ChatResource, messageId: string): Promise<void> {
    const personId = actorPersonId(context);
    const done = await this.db.withTenant(context, async (tx) => {
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId || message.kind !== "text") {
        throw new DomainError("not_found");
      }
      if (message.senderPersonId === personId) throw new DomainError("not_allowed");
      if (message.hiddenReason === "moderator") return false;
      await repo.hideMessage(tx, messageId, personId, "moderator");
      await audit.record(tx, {
        action: "chat.message.moderated",
        resourceType: "chat_message",
        resourceId: messageId,
        changedFields: ["hidden_at"],
      });
      await outbox.publish(tx, "chat.message.moderated", {
        clubId: context.clubId,
        chatId: chat.chatId,
        messageId,
        personId: message.senderPersonId!,
      });
      return true;
    });
    if (done) {
      await this.publisher.toChat(chat.chatId, {
        type: "message.updated",
        clubId: context.clubId,
        chatId: chat.chatId,
        messageId,
      });
    }
  }

  async react(
    context: TenantContext,
    chat: ChatResource,
    messageId: string,
    emoji: string,
    on: boolean,
  ): Promise<void> {
    const personId = actorPersonId(context);
    const changed = await this.db.withTenant(context, async (tx) => {
      await this.refuseMuted(tx, context.clubId, personId);
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId) throw new DomainError("not_found");
      if (message.kind !== "text" || message.hiddenAt) throw new DomainError("chat_message_hidden");
      return repo.setReaction(tx, context.clubId, messageId, personId, emoji, on);
    });
    if (changed) {
      await this.publisher.toChat(chat.chatId, {
        type: "message.updated",
        clubId: context.clubId,
        chatId: chat.chatId,
        messageId,
      });
    }
  }

  /** Read receipts: the caller has read up to the message (forward only). */
  async markRead(context: TenantContext, chat: ChatResource, messageId: string): Promise<void> {
    const personId = actorPersonId(context);
    if (chat.membership !== "active") throw new DomainError("chat_not_a_member");
    const moved = await this.db.withTenant(context, async (tx) => {
      const message = await repo.findMessage(tx, messageId);
      if (!message || message.chatId !== chat.chatId) throw new DomainError("not_found");
      return repo.markRead(tx, chat.chatId, personId, messageId);
    });
    if (moved) {
      await this.publisher.toChat(chat.chatId, {
        type: "chat.read",
        clubId: context.clubId,
        chatId: chat.chatId,
        personId,
        messageId,
      });
      // The reader's other devices update their unread counts.
      await this.publisher.toPeople([personId], { type: "chats.changed" });
    }
  }

  // --- Real time ---------------------------------------------------------------------

  private async publish(fx: Effects): Promise<void> {
    if (fx.chatUpdated) {
      await this.publisher.toChat(fx.chatId, {
        type: "chat.updated",
        clubId: fx.clubId,
        chatId: fx.chatId,
      });
    }
    if (fx.people.size > 0) await this.publisher.toPeople(fx.people, { type: "chats.changed" });
  }

  /** A system event worth a message (for tests and the seed: the kinds used). */
  static readonly SYSTEM_EVENTS: readonly ChatSystemEvent[] = [
    "created",
    "joined",
    "left",
    "added",
    "removed",
    "guardians_added",
    "renamed",
    "archived",
  ];
}
