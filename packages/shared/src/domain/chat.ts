// SPDX-License-Identifier: AGPL-3.0-only
// Chat (P2.1, ADR 0016, ADR 0047): channels in groups and the club, direct
// messages, messages with every edit kept, reactions, read receipts, and the
// real-time connection's events. People appear only as PersonSummary from
// the presenter (ADR 0022); real-time events carry IDs only.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

export const CHAT_KINDS = ["channel", "direct"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export const CHAT_VISIBILITIES = ["open", "closed"] as const;
export type ChatVisibility = (typeof CHAT_VISIBILITIES)[number];

export const CHAT_MEMBER_STATUSES = ["active", "offered", "left"] as const;
export type ChatMemberStatus = (typeof CHAT_MEMBER_STATUSES)[number];

/** Why someone is in a chat; everyone in it sees it (ADR 0047: openness). */
export const CHAT_MEMBER_REASONS = [
  "creator",
  "added",
  "joined",
  /** The group's default channel: everyone in the group. */
  "group",
  /** Added because a leader or another adult is in the chat with their child (ADR 0047 rule 3). */
  "guardian_auto",
  /** A guardian who joined their child's chat. */
  "guardian_joined",
  /** A leader of the group who joined a children's chat. */
  "leader_joined",
] as const;
export type ChatMemberReason = (typeof CHAT_MEMBER_REASONS)[number];

export const CHAT_PUSH_SETTINGS = ["all", "mentions", "off"] as const;
export type ChatPushSetting = (typeof CHAT_PUSH_SETTINGS)[number];

export const CHAT_MESSAGE_KINDS = ["text", "system"] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

/** What a system message records (IDs only; the client words it). */
export const CHAT_SYSTEM_EVENTS = [
  "created",
  "joined",
  "left",
  "added",
  "removed",
  "guardians_added",
  "renamed",
  "archived",
] as const;
export type ChatSystemEvent = (typeof CHAT_SYSTEM_EVENTS)[number];

export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_NAME_MAX_LENGTH = 80;
/** A message's client-chosen ID must be this close to now (UUIDv7 time, offline queue). */
export const CHAT_CLIENT_ID_MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
/** Members added to a chat in one request. */
export const CHAT_MAX_ADD = 500;

export const ChatParamsSchema = z.object({ clubId: z.uuid(), chatId: z.uuid() });
export const ChatMessageParamsSchema = ChatParamsSchema.extend({ messageId: z.uuid() });
export const ChatMemberParamsSchema = ChatParamsSchema.extend({ personId: z.uuid() });

/**
 * Who wrote a message or is in a chat, as the viewer may see them: a
 * person; someone with protected identity the viewer may not see; or a
 * former member (erased). Clients treat unknown kinds as "protected".
 */
export const ChatPersonSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), person: PersonSummarySchema }),
    z.object({ kind: z.literal("protected") }),
    z.object({ kind: z.literal("former_member") }),
  ])
  .openapi("ChatPerson");
export type ChatPerson = z.infer<typeof ChatPersonSchema>;

export const ChatMemberSchema = z
  .object({
    /** Null for someone the viewer may not see (protected identity). */
    personId: z.uuid().nullable(),
    person: ChatPersonSchema,
    status: z.enum(CHAT_MEMBER_STATUSES),
    reason: z.enum(CHAT_MEMBER_REASONS),
    role: z.enum(["owner", "member"]),
    /** A child (below the country pack's adult age) in this club. */
    child: z.boolean(),
    /** Leads one of the chat's groups (or, for others, the club). */
    leader: z.boolean(),
    /** Whose guardian this member is, among the chat's members (IDs the viewer may see). */
    guardianOf: z.array(z.uuid()),
    joinedAt: z.iso.datetime(),
    /** The last message they read (read receipts). */
    lastReadMessageId: z.uuid().nullable(),
  })
  .openapi("ChatMember");
export type ChatMember = z.infer<typeof ChatMemberSchema>;

export const ChatSummarySchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    kind: z.enum(CHAT_KINDS),
    /** Channels: their name; direct messages: null (shown by the other person's name). */
    name: z.string().nullable(),
    description: z.string().nullable(),
    visibility: z.enum(CHAT_VISIBILITIES).nullable(),
    groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
    /** The group's default channel (everyone in the group). */
    defaultForGroupId: z.uuid().nullable(),
    archived: z.boolean(),
    /** The other person of a direct message, as the viewer may see them. */
    counterpart: ChatPersonSchema.nullable(),
    /** The caller's membership: null when they see the chat without being in it. */
    membership: z
      .object({
        status: z.enum(CHAT_MEMBER_STATUSES),
        push: z.enum(CHAT_PUSH_SETTINGS),
        lastReadMessageId: z.uuid().nullable(),
      })
      .nullable(),
    memberCount: z.number().int(),
    /** Children are in it: guardians may join, push shows no text (ADR 0047). */
    hasChildren: z.boolean(),
    unreadCount: z.number().int(),
    lastMessage: z
      .object({
        id: z.uuid(),
        sender: ChatPersonSchema.nullable(),
        kind: z.enum(CHAT_MESSAGE_KINDS),
        /** The start of the text; empty when hidden or a system message. */
        excerpt: z.string(),
        createdAt: z.iso.datetime(),
      })
      .nullable(),
    lastMessageAt: z.iso.datetime().nullable(),
  })
  .openapi("ChatSummary");
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

export const ChatPageSchema = z
  .object({ items: z.array(ChatSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("ChatPage");
export type ChatPage = z.infer<typeof ChatPageSchema>;

export const ChatListSchema = z
  .object({
    items: z.array(ChatSummarySchema),
    /** The caller may create a channel here (the group's, or the club's). */
    canCreate: z.boolean().optional(),
  })
  .openapi("ChatList");
export type ChatList = z.infer<typeof ChatListSchema>;

export const ChatDetailSchema = z
  .object({
    chat: ChatSummarySchema,
    members: z.array(ChatMemberSchema),
    /** Members the viewer may not see (protected identity), counted. */
    hiddenMembers: z.number().int(),
    can: z.object({
      post: z.boolean(),
      join: z.boolean(),
      leave: z.boolean(),
      manage: z.boolean(),
    }),
  })
  .openapi("ChatDetail");
export type ChatDetail = z.infer<typeof ChatDetailSchema>;

const nameField = z.string().trim().min(1).max(CHAT_NAME_MAX_LENGTH);

export const CreateChannelSchema = z
  .object({
    name: nameField,
    description: z.string().trim().max(500).nullish(),
    visibility: z.enum(CHAT_VISIBILITIES),
    /** People to add besides the creator (people of the group for group channels). */
    memberIds: z.array(z.uuid()).max(CHAT_MAX_ADD).default([]),
    /** Group channels: add everyone in the group (open channels only). */
    everyone: z.boolean().default(false),
  })
  .strict()
  .openapi("CreateChannel");
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const CreateDirectChatSchema = z
  .object({ personId: z.uuid() })
  .strict()
  .openapi("CreateDirectChat");
export type CreateDirectChatInput = z.infer<typeof CreateDirectChatSchema>;

export const UpdateChatSchema = z
  .object({
    name: nameField.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    visibility: z.enum(CHAT_VISIBILITIES).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .openapi("UpdateChat");
export type UpdateChatInput = z.infer<typeof UpdateChatSchema>;

export const AddChatMembersSchema = z
  .object({ personIds: z.array(z.uuid()).min(1).max(CHAT_MAX_ADD) })
  .strict()
  .openapi("AddChatMembers");
export type AddChatMembersInput = z.infer<typeof AddChatMembersSchema>;

export const ChatSettingsSchema = z
  .object({ push: z.enum(CHAT_PUSH_SETTINGS) })
  .strict()
  .openapi("ChatSettings");
export type ChatSettingsInput = z.infer<typeof ChatSettingsSchema>;

export const ChatReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int(),
  /** The caller reacted with it. */
  mine: z.boolean(),
});

export const ChatMessageSchema = z
  .object({
    id: z.uuid(),
    chatId: z.uuid(),
    kind: z.enum(CHAT_MESSAGE_KINDS),
    /** Null for system messages. */
    sender: ChatPersonSchema.nullable(),
    senderId: z.uuid().nullable(),
    /** Empty when hidden. */
    body: z.string(),
    /** System messages: what happened and to whom (IDs the viewer may see). */
    event: z.object({ type: z.enum(CHAT_SYSTEM_EVENTS), personIds: z.array(z.uuid()) }).nullable(),
    replyTo: z
      .object({
        id: z.uuid(),
        sender: ChatPersonSchema.nullable(),
        excerpt: z.string(),
      })
      .nullable(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    /** Hidden by its sender (deleted) or a moderator: the text is not shown (ADR 0047). */
    hidden: z.enum(["sender", "moderator"]).nullable(),
    reactions: z.array(ChatReactionSummarySchema),
  })
  .openapi("ChatMessage");
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * A chat's messages: newest first from `cursor` (older pages), or oldest
 * first after `after` (catching up after a real-time event).
 */
export const ChatMessagesQuerySchema = z.object({
  cursor: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ChatMessagesQuery = z.infer<typeof ChatMessagesQuerySchema>;

export const ChatMessagePageSchema = z
  .object({
    items: z.array(ChatMessageSchema),
    /** Older messages exist (with `cursor`) or newer ones (with `after`). */
    nextCursor: z.uuid().nullable(),
  })
  .openapi("ChatMessagePage");
export type ChatMessagePage = z.infer<typeof ChatMessagePageSchema>;

export const SendChatMessageSchema = z
  .object({
    /** A UUIDv7 the client chose (its offline queue resends it safely). */
    id: z.uuid().optional(),
    body: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
    replyToId: z.uuid().nullish(),
  })
  .strict()
  .openapi("SendChatMessage");
export type SendChatMessageInput = z.infer<typeof SendChatMessageSchema>;

export const EditChatMessageSchema = z
  .object({ body: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH) })
  .strict()
  .openapi("EditChatMessage");
export type EditChatMessageInput = z.infer<typeof EditChatMessageSchema>;

export const ChatMessageVersionsSchema = z
  .object({
    /** Earlier texts, oldest first; the current text is the message's. */
    items: z.array(z.object({ body: z.string(), writtenAt: z.iso.datetime() })),
  })
  .openapi("ChatMessageVersions");
export type ChatMessageVersions = z.infer<typeof ChatMessageVersionsSchema>;

export const ChatReactionSchema = z
  .object({
    emoji: z.string().trim().min(1).max(16),
    /** Add (true) or remove (false) the caller's reaction. */
    on: z.boolean(),
  })
  .strict()
  .openapi("ChatReaction");
export type ChatReactionInput = z.infer<typeof ChatReactionSchema>;

export const ChatReadSchema = z.object({ messageId: z.uuid() }).strict().openapi("ChatRead");
export type ChatReadInput = z.infer<typeof ChatReadSchema>;

// --- Real time ------------------------------------------------------------

/** The WebSocket path under the API's /api/v1 prefix. */
export const REALTIME_PATH = "/api/v1/realtime";
/** How long a connection ticket is valid (single use). */
export const REALTIME_TICKET_TTL_SECONDS = 60;

export const RealtimeTicketSchema = z
  .object({
    ticket: z.string(),
    /** The WebSocket URL to connect to, with the ticket as `ticket` query parameter. */
    url: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .openapi("RealtimeTicket");
export type RealtimeTicket = z.infer<typeof RealtimeTicketSchema>;

/**
 * Events the server sends. They carry IDs only: clients fetch the content
 * through the API, where the presenter and the rules apply (ADR 0022).
 * Clients ignore unknown types (ADR 0029).
 */
export type RealtimeServerEvent =
  | { type: "ready"; personId: string }
  | { type: "message.created"; clubId: string; chatId: string; messageId: string }
  | { type: "message.updated"; clubId: string; chatId: string; messageId: string }
  | { type: "chat.updated"; clubId: string; chatId: string }
  | { type: "chat.read"; clubId: string; chatId: string; personId: string; messageId: string }
  | { type: "typing"; clubId: string; chatId: string; personId: string }
  /** The caller's chats changed (added, removed): refresh the list. */
  | { type: "chats.changed" }
  /** What the caller may do changed (P1.15 A2): refresh permissions. */
  | { type: "authz.changed" }
  | { type: "pong" };

/** Events clients send. */
export const RealtimeClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typing"), chatId: z.uuid() }),
  z.object({ type: z.literal("ping") }),
]);
export type RealtimeClientEvent = z.infer<typeof RealtimeClientEventSchema>;

/** Valkey channels between API instances (and the worker). */
export const realtimeChatChannel = (chatId: string) => `rt:chat:${chatId}`;
export const realtimePersonChannel = (personId: string) => `rt:person:${personId}`;
