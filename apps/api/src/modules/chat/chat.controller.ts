// SPDX-License-Identifier: AGPL-3.0-only
// Chat endpoints (P2.1, ADR 0016, ADR 0047). The policies decide who may
// ask (read, join, post, manage a chat; create channels; start a direct
// message); the service applies the rules about whom and the guardian rule.
// Messages are for active members; guardians and leaders join visibly.
// People go through the PersonPresenter (chat.views.ts).

import {
  type AddChatMembersInput,
  AddChatMembersSchema,
  type ChatDetail,
  ChatDetailSchema,
  type ChatList,
  ChatListSchema,
  ChatMemberParamsSchema,
  type ChatMessage,
  type ChatMessagePage,
  ChatMessagePageSchema,
  ChatMessageParamsSchema,
  ChatMessageSchema,
  type ChatMessagesQuery,
  ChatMessagesQuerySchema,
  type ChatMessageVersions,
  ChatMessageVersionsSchema,
  type ChatPage,
  ChatPageSchema,
  ChatParamsSchema,
  type ChatReactionInput,
  ChatReactionSchema,
  type ChatReadInput,
  ChatReadSchema,
  type ChatSettingsInput,
  ChatSettingsSchema,
  ChatSummarySchema,
  ClubParamsSchema,
  type CreateChannelInput,
  CreateChannelSchema,
  type CreateDirectChatInput,
  CreateDirectChatSchema,
  type EditChatMessageInput,
  EditChatMessageSchema,
  GroupParamsSchema,
  type PageQuery,
  PageQuerySchema,
  type SendChatMessageInput,
  SendChatMessageSchema,
  type UpdateChatInput,
  UpdateChatSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  type Actor,
  canJoinChat,
  canManageChat,
  canPostInChat,
  canReadChat,
  type ChatResource,
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import { PeopleService } from "../people/index.ts";
import { type ChatListRow, ChatService } from "./chat.service.ts";
import {
  ChatPeople,
  peopleOfList,
  peopleOfMessages,
  toChatMembers,
  toChatMessage,
  toChatSummary,
} from "./chat.views.ts";

const GroupInClubParamsSchema = ClubParamsSchema.merge(GroupParamsSchema);
const EmptySchema = z.object({}).openapi("Empty");

/** Sending: a per-account budget on top of the global limit (abuse, flooding). */
const SEND_LIMIT = { max: 120, timeWindowMs: 60_000 };

/** The chat as a resource for the policy helpers, from a list row. */
function resourceOfRow(
  row: ChatListRow,
  actor: Actor,
  groups: ChatResource["groups"],
): ChatResource {
  return {
    kind: "chat",
    clubId: row.chat.clubId,
    chatId: row.chat.id,
    chatKind: row.chat.kind,
    visibility: row.chat.visibility,
    archived: row.chat.archivedAt !== null,
    createdByPersonId: row.chat.createdByPersonId,
    defaultForGroupId: row.chat.defaultForGroupId,
    groups,
    membership:
      row.membership?.status === "active" || row.membership?.status === "offered"
        ? row.membership.status
        : null,
    // Lists do not load wards' memberships: a guardian finds their child's
    // chats on the child's page (P2.1 B).
    wardMembers: [],
    hasChildren: row.chat.hasChildren,
  };
}

@Controller()
export class ChatController {
  private readonly chats: ChatService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(chats: ChatService, people: PeopleService, presenter: PersonPresenter) {
    this.chats = chats;
    this.people = people;
    this.presenter = presenter;
  }

  private async summaries(
    authz: RequestAuthorization,
    rows: readonly ChatListRow[],
    names: Parameters<typeof toChatSummary>[1],
  ) {
    const people = await ChatPeople.load(this.people, this.presenter, authz, peopleOfList(rows));
    return rows.map((r) => toChatSummary(r, names, people.get(r.chat.clubId)));
  }

  @Endpoint({
    method: "GET",
    path: "me/chats",
    summary: "Mina kanaler: the caller's chats across clubs and groups, newest activity first",
    tags: ["chat"],
    access: { authenticated: true },
    request: { query: PageQuerySchema },
    response: ChatPageSchema,
  })
  async myChats(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<ChatPage> {
    // A guardian acting as a ward never reads the ward's chats (ADR 0047 rule 6).
    if (authz.actor.onBehalfOf) return { items: [], nextCursor: null };
    const page = await this.chats.myChats(authz.context, query);
    return {
      items: await this.summaries(authz, page.rows, page.names),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/chats",
    summary: "A group's chats the caller may see (its default channel first)",
    tags: ["chat"],
    access: { permission: "group.read", resource: "group" },
    request: { params: GroupInClubParamsSchema },
    response: ChatListSchema,
  })
  @RequiresEntitlement("chat")
  async groupChats(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
  ): Promise<ChatList> {
    const group = resourceOf(authz, "group");
    const { rows, names } = await this.chats.groupChats(
      tenantContext(authz, params.clubId),
      params.groupId,
    );
    const ref = { clubId: group.clubId, groupId: group.groupId, ancestorIds: group.ancestorIds };
    const visible = rows.filter((r) => {
      const chat = resourceOfRow(r, authz.actor, [ref]);
      return canReadChat(authz.actor, chat);
    });
    return {
      items: await this.summaries(authz, visible, names),
      canCreate: permits(authz.actor, "group.channels.create", group),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/chats",
    summary: "Create a channel in a group and choose its members",
    tags: ["chat"],
    access: { permission: "group.channels.create", resource: "group" },
    request: { params: GroupInClubParamsSchema, body: CreateChannelSchema },
    response: ChatSummarySchema,
  })
  @RequiresEntitlement("chat")
  async createGroupChannel(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: CreateChannelInput,
  ) {
    const context = tenantContext(authz, params.clubId);
    const chatId = await this.chats.createChannel(context, { ...body, groupId: params.groupId });
    return (await this.loadDetail(authz, params.clubId, chatId)).chat;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/chats",
    summary: "The club's channels (not tied to a group) the caller may see",
    tags: ["chat"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ChatListSchema,
  })
  @RequiresEntitlement("chat")
  async clubChannels(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<ChatList> {
    const { rows, names } = await this.chats.clubChannels(tenantContext(authz, params.clubId));
    const visible = rows.filter((r) => canReadChat(authz.actor, resourceOfRow(r, authz.actor, [])));
    return {
      items: await this.summaries(authz, visible, names),
      canCreate: permits(authz.actor, "club.channels.create", {
        kind: "club",
        clubId: params.clubId,
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats",
    summary: "Create a club channel (the board, all leaders) and choose its members",
    tags: ["chat"],
    access: { permission: "club.channels.create", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateChannelSchema },
    response: ChatSummarySchema,
  })
  @RequiresEntitlement("chat")
  async createClubChannel(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateChannelInput,
  ) {
    const chatId = await this.chats.createChannel(tenantContext(authz, params.clubId), {
      ...body,
      everyone: false,
      groupId: null,
    });
    return (await this.loadDetail(authz, params.clubId, chatId)).chat;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/direct-chats",
    summary: "Open the direct chat with a person (ADR 0047: a child's guardians are added)",
    tags: ["chat"],
    access: { permission: "club.chats.direct", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateDirectChatSchema },
    response: ChatSummarySchema,
  })
  @RequiresEntitlement("chat")
  async openDirect(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateDirectChatInput,
  ) {
    const chatId = await this.chats.openDirect(tenantContext(authz, params.clubId), body.personId);
    return (await this.loadDetail(authz, params.clubId, chatId)).chat;
  }

  private async loadDetail(
    authz: RequestAuthorization,
    clubId: string,
    chatId: string,
    chat?: ChatResource,
  ): Promise<ChatDetail> {
    const { row, members, names } = await this.chats.detail(tenantContext(authz, clubId), chatId);
    const ids = new Set<string>(members.map((m) => m.personId));
    for (const m of members) for (const w of m.guardianOf) ids.add(w);
    for (const id of peopleOfList([row]).get(clubId) ?? []) ids.add(id);
    const people = (
      await ChatPeople.load(this.people, this.presenter, authz, new Map([[clubId, ids]]))
    ).get(clubId)!;
    const shown = toChatMembers(members, people);
    const resource = chat ?? resourceOfRow(row, authz.actor, []);
    return {
      chat: toChatSummary(row, names, people),
      members: shown.members,
      hiddenMembers: shown.hidden,
      can: {
        post: canPostInChat(authz.actor, resource),
        join: canJoinChat(authz.actor, resource),
        leave:
          row.membership?.status === "active" &&
          row.chat.kind === "channel" &&
          row.chat.defaultForGroupId === null &&
          !members.some((m) => m.personId === authz.actor.personId && m.reason === "guardian_auto"),
        manage: canManageChat(authz.actor, resource),
      },
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/chats/:chatId",
    summary: "A chat, who is in it and why, and what the caller may do",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatParamsSchema },
    response: ChatDetailSchema,
  })
  @RequiresEntitlement("chat")
  detail(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
  ): Promise<ChatDetail> {
    return this.loadDetail(authz, params.clubId, params.chatId, resourceOf(authz, "chat"));
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/chats/:chatId",
    summary: "Rename, describe, open or close, or archive a channel",
    tags: ["chat"],
    access: { permission: "chat.manage", resource: "chat" },
    request: { params: ChatParamsSchema, body: UpdateChatSchema },
    response: ChatDetailSchema,
  })
  @RequiresEntitlement("chat")
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Body() body: UpdateChatInput,
  ): Promise<ChatDetail> {
    await this.chats.update(tenantContext(authz, params.clubId), resourceOf(authz, "chat"), body);
    return this.loadDetail(authz, params.clubId, params.chatId);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/members",
    summary: "Add people to a channel (protected people are offered it)",
    tags: ["chat"],
    access: { permission: "chat.manage", resource: "chat" },
    request: { params: ChatParamsSchema, body: AddChatMembersSchema },
    response: ChatDetailSchema,
  })
  @RequiresEntitlement("chat")
  async addMembers(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Body() body: AddChatMembersInput,
  ): Promise<ChatDetail> {
    await this.chats.addMembers(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      body.personIds,
    );
    return this.loadDetail(authz, params.clubId, params.chatId);
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/chats/:chatId/members/:personId",
    summary: "Remove someone from a channel",
    tags: ["chat"],
    access: { permission: "chat.manage", resource: "chat" },
    request: { params: ChatMemberParamsSchema },
    response: ChatDetailSchema,
  })
  @RequiresEntitlement("chat")
  async removeMember(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string; personId: string },
  ): Promise<ChatDetail> {
    await this.chats.removeMember(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      params.personId,
    );
    return this.loadDetail(authz, params.clubId, params.chatId);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/join",
    summary: "Join an open channel, a child's chat (guardians) or accept an offer; visible to all",
    tags: ["chat"],
    access: { permission: "chat.join", resource: "chat" },
    request: { params: ChatParamsSchema },
    response: ChatDetailSchema,
  })
  @RequiresEntitlement("chat")
  async join(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
  ): Promise<ChatDetail> {
    const chat = resourceOf(authz, "chat");
    const insider =
      chat.groups.length === 0
        ? authz.actor.hasClubRelationship(chat.clubId)
        : chat.groups.some((g) => authz.actor.isGroupMember(g.groupId) || authz.actor.ownsGroup(g));
    const leads = chat.hasChildren && chat.groups.some((g) => authz.actor.holds("group.lead", g));
    const as =
      chat.membership === "offered"
        ? "self"
        : leads
          ? "leader"
          : chat.wardMembers.length > 0 && !(chat.visibility === "open" && insider)
            ? "guardian"
            : "self";
    await this.chats.join(tenantContext(authz, params.clubId), chat, as);
    return this.loadDetail(authz, params.clubId, params.chatId);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/leave",
    summary: "Leave a channel, or decline an offer",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatParamsSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async leave(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
  ): Promise<Record<string, never>> {
    await this.chats.leave(tenantContext(authz, params.clubId), resourceOf(authz, "chat"));
    return {};
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/chats/:chatId/settings",
    summary: "The caller's push setting for the chat (every message, mentions, none)",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatParamsSchema, body: ChatSettingsSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async settings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Body() body: ChatSettingsInput,
  ): Promise<Record<string, never>> {
    await this.chats.setPush(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      body.push,
    );
    return {};
  }

  // --- Messages ----------------------------------------------------------------------

  private async presentMessages(
    authz: RequestAuthorization,
    clubId: string,
    page: Parameters<typeof peopleOfMessages>[0] &
      Pick<Parameters<typeof toChatMessage>[1], "reactions">,
  ): Promise<ChatMessage[]> {
    const people = (
      await ChatPeople.load(
        this.people,
        this.presenter,
        authz,
        new Map([[clubId, peopleOfMessages(page)]]),
      )
    ).get(clubId)!;
    return page.items.map((m) => toChatMessage(m, page, people));
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/chats/:chatId/messages",
    summary: "A chat's messages: older pages with cursor, newer ones with after",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatParamsSchema, query: ChatMessagesQuerySchema },
    response: ChatMessagePageSchema,
  })
  @RequiresEntitlement("chat")
  async messages(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Query() query: ChatMessagesQuery,
  ): Promise<ChatMessagePage> {
    const page = await this.chats.messages(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      query,
    );
    return {
      items: await this.presentMessages(authz, params.clubId, page),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/messages",
    summary: "Send a message (text; the client may choose its UUIDv7 ID to resend safely)",
    tags: ["chat"],
    access: { permission: "chat.post", resource: "chat" },
    request: { params: ChatParamsSchema, body: SendChatMessageSchema },
    response: ChatMessageSchema,
    rateLimit: SEND_LIMIT,
  })
  @RequiresEntitlement("chat")
  async send(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Body() body: SendChatMessageInput,
  ): Promise<ChatMessage> {
    const message = await this.chats.send(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      body,
    );
    return this.presentOne(authz, params, message.id);
  }

  /** One message as the caller sees it (after sending or editing). */
  private async presentOne(
    authz: RequestAuthorization,
    params: { clubId: string; chatId: string },
    messageId: string,
  ): Promise<ChatMessage> {
    const chat = resourceOf(authz, "chat");
    const page = await this.chats.messages(tenantContext(authz, params.clubId), chat, {
      after: precedingId(messageId),
      limit: 1,
    });
    const [message] = await this.presentMessages(authz, params.clubId, page);
    return message!;
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/chats/:chatId/messages/:messageId",
    summary: "Edit one's own message (every earlier text is kept)",
    tags: ["chat"],
    access: { permission: "chat.post", resource: "chat" },
    request: { params: ChatMessageParamsSchema, body: EditChatMessageSchema },
    response: ChatMessageSchema,
  })
  @RequiresEntitlement("chat")
  async edit(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string; messageId: string },
    @Body() body: EditChatMessageInput,
  ): Promise<ChatMessage> {
    await this.chats.edit(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      params.messageId,
      body.body,
    );
    return this.presentOne(authz, params, params.messageId);
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/chats/:chatId/messages/:messageId",
    summary: "Delete one's own message: it is hidden, not removed (ADR 0047)",
    tags: ["chat"],
    access: { permission: "chat.post", resource: "chat" },
    request: { params: ChatMessageParamsSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async hide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string; messageId: string },
  ): Promise<Record<string, never>> {
    await this.chats.hide(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      params.messageId,
    );
    return {};
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/chats/:chatId/messages/:messageId/versions",
    summary: "The earlier texts of an edited message",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatMessageParamsSchema },
    response: ChatMessageVersionsSchema,
  })
  @RequiresEntitlement("chat")
  async versions(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string; messageId: string },
  ): Promise<ChatMessageVersions> {
    const rows = await this.chats.versions(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      params.messageId,
    );
    return { items: rows.map((r) => ({ body: r.body, writtenAt: r.writtenAt.toISOString() })) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/messages/:messageId/reactions",
    summary: "React to a message, or take the reaction back",
    tags: ["chat"],
    access: { permission: "chat.post", resource: "chat" },
    request: { params: ChatMessageParamsSchema, body: ChatReactionSchema },
    response: ChatMessageSchema,
  })
  @RequiresEntitlement("chat")
  async react(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string; messageId: string },
    @Body() body: ChatReactionInput,
  ): Promise<ChatMessage> {
    await this.chats.react(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      params.messageId,
      body.emoji,
      body.on,
    );
    return this.presentOne(authz, params, params.messageId);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/chats/:chatId/read",
    summary: "Mark the chat read up to a message (read receipts)",
    tags: ["chat"],
    access: { permission: "chat.read", resource: "chat" },
    request: { params: ChatParamsSchema, body: ChatReadSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async read(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; chatId: string },
    @Body() body: ChatReadInput,
  ): Promise<Record<string, never>> {
    await this.chats.markRead(
      tenantContext(authz, params.clubId),
      resourceOf(authz, "chat"),
      body.messageId,
    );
    return {};
  }
}

/**
 * The UUID just below `id` (lexically), so `after` returns the message itself
 * first. UUIDs compare as 128-bit numbers.
 */
export function precedingId(id: string): string {
  const hex = id.replace(/-/g, "");
  const value = BigInt(`0x${hex}`) - 1n;
  const out = value.toString(16).padStart(32, "0");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
