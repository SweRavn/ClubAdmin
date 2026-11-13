// SPDX-License-Identifier: AGPL-3.0-only
// Chat (P2.1, ADR 0016, ADR 0047; migration 0037): chats with their groups
// and members, messages (partitioned by month on their UUIDv7 ID, created
// by hand in the migration), every earlier text of an edited message,
// prepared attachments, and reactions.

import {
  CHAT_KINDS,
  CHAT_MEMBER_REASONS,
  CHAT_MEMBER_STATUSES,
  CHAT_MESSAGE_KINDS,
  CHAT_PUSH_SETTINGS,
  CHAT_VISIBILITIES,
  type ChatKind,
  type ChatMemberReason,
  type ChatMemberStatus,
  type ChatMessageKind,
  type ChatPushSetting,
  type ChatSystemEvent,
  type ChatVisibility,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { clubRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";
import { people } from "./people.ts";

export const chats = pgTable(
  "chats",
  {
    id: id(),
    clubId: clubRef(),
    kind: text().$type<ChatKind>().notNull(),
    name: text(),
    description: text(),
    visibility: text().$type<ChatVisibility>(),
    defaultForGroupId: uuid().references(() => groups.id),
    createdByPersonId: uuid().references(() => people.id),
    archivedAt: timestamp(tz),
    archivedByPersonId: uuid().references(() => people.id),
    hasChildren: boolean().notNull().default(false),
    lastMessageId: uuid(),
    lastMessageAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("chats_club_id_unique").on(t.clubId, t.id),
    check("chats_kind", oneOf(t.kind, CHAT_KINDS)),
    check("chats_visibility", oneOf(t.visibility, CHAT_VISIBILITIES)),
    uniqueIndex("chats_default_for_group_unique")
      .on(t.defaultForGroupId)
      .where(sql`${t.defaultForGroupId} IS NOT NULL`),
    index("chats_club_idx").on(t.clubId, t.lastMessageAt.desc()),
    index("chats_created_by_idx").on(t.createdByPersonId),
  ],
);

export const chatGroups = pgTable(
  "chat_groups",
  {
    id: id(),
    clubId: uuid().notNull(),
    chatId: uuid().notNull(),
    groupId: uuid()
      .notNull()
      .references(() => groups.id),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "chat_groups_chat_fk",
      columns: [t.clubId, t.chatId],
      foreignColumns: [chats.clubId, chats.id],
    }).onDelete("cascade"),
    unique("chat_groups_unique").on(t.chatId, t.groupId),
    index("chat_groups_group_idx").on(t.groupId, t.chatId),
  ],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    id: id(),
    clubId: uuid().notNull(),
    chatId: uuid().notNull(),
    personId: uuid()
      .notNull()
      .references(() => people.id),
    status: text().$type<ChatMemberStatus>().notNull().default("active"),
    reason: text().$type<ChatMemberReason>().notNull(),
    role: text().$type<"owner" | "member">().notNull().default("member"),
    addedByPersonId: uuid().references(() => people.id),
    joinedAt: timestamp(tz).notNull().defaultNow(),
    leftAt: timestamp(tz),
    removedByPersonId: uuid().references(() => people.id),
    lastReadMessageId: uuid(),
    lastReadAt: timestamp(tz),
    push: text().$type<ChatPushSetting>().notNull().default("all"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "chat_members_chat_fk",
      columns: [t.clubId, t.chatId],
      foreignColumns: [chats.clubId, chats.id],
    }).onDelete("cascade"),
    unique("chat_members_unique").on(t.chatId, t.personId),
    check("chat_members_status", oneOf(t.status, CHAT_MEMBER_STATUSES)),
    check("chat_members_reason", oneOf(t.reason, CHAT_MEMBER_REASONS)),
    check("chat_members_push", oneOf(t.push, CHAT_PUSH_SETTINGS)),
    index("chat_members_person_idx")
      .on(t.personId, t.chatId)
      .where(sql`${t.status} <> 'left'`),
  ],
);

/** Partitioned by range of `id` (migration 0037); the partitions are not in this schema. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    clubId: uuid().notNull(),
    chatId: uuid().notNull(),
    senderPersonId: uuid().references(() => people.id),
    kind: text().$type<ChatMessageKind>().notNull().default("text"),
    body: text().notNull().default(""),
    event: jsonb().$type<{ type: ChatSystemEvent; personIds: string[] }>(),
    replyToMessageId: uuid(),
    editedAt: timestamp(tz),
    hiddenAt: timestamp(tz),
    hiddenByPersonId: uuid().references(() => people.id),
    hiddenReason: text().$type<"sender" | "moderator">(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "chat_messages_chat_fk",
      columns: [t.clubId, t.chatId],
      foreignColumns: [chats.clubId, chats.id],
    }).onDelete("cascade"),
    check("chat_messages_kind", oneOf(t.kind, CHAT_MESSAGE_KINDS)),
    index("chat_messages_chat_idx").on(t.chatId, t.id.desc()),
  ],
);

export const chatMessageVersions = pgTable(
  "chat_message_versions",
  {
    id: id(),
    clubId: clubRef(),
    messageId: uuid()
      .notNull()
      .references(() => chatMessages.id),
    body: text().notNull(),
    writtenAt: timestamp(tz).notNull(),
    ...timestamps,
  },
  (t) => [index("chat_message_versions_message_idx").on(t.messageId, t.writtenAt)],
);

/** Prepared for files on messages; unused in the first revision (P2.1). */
export const chatMessageAttachments = pgTable(
  "chat_message_attachments",
  {
    id: id(),
    clubId: clubRef(),
    messageId: uuid()
      .notNull()
      .references(() => chatMessages.id),
    objectKey: text().notNull(),
    fileName: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    scanStatus: text().$type<"pending" | "clean" | "infected">().notNull().default("pending"),
    ...timestamps,
  },
  (t) => [index("chat_message_attachments_message_idx").on(t.messageId)],
);

export const chatReactions = pgTable(
  "chat_reactions",
  {
    id: id(),
    clubId: clubRef(),
    messageId: uuid()
      .notNull()
      .references(() => chatMessages.id),
    personId: uuid()
      .notNull()
      .references(() => people.id),
    emoji: text().notNull(),
    ...timestamps,
  },
  (t) => [
    unique("chat_reactions_unique").on(t.messageId, t.personId, t.emoji),
    index("chat_reactions_person_idx").on(t.personId),
  ],
);
