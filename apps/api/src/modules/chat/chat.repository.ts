// SPDX-License-Identifier: AGPL-3.0-only
// Queries on chats, their members and messages (P2.1). IDs only towards
// people: no query here reads names (the presenter does). The child-safety
// rules live in SQL functions of migration 0037 (app.chat_*), called here.

import { and, eq, schema, sql, type Tx } from "@clubadmin/db";
import type {
  ChatMemberReason,
  ChatMemberStatus,
  ChatPushSetting,
  ChatSystemEvent,
} from "@clubadmin/shared";

const { chats, chatGroups, chatMembers, chatMessages, chatMessageVersions } = schema;

export type ChatRow = typeof chats.$inferSelect;
export type ChatMemberRow = typeof chatMembers.$inferSelect;
export type MessageRow = typeof chatMessages.$inferSelect;

/** A uuid[] parameter (IDs only; validated as UUIDs where they enter). */
const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;
const NIL = "00000000-0000-0000-0000-000000000000";

/** A chat as lists show it, with the reader's membership and counts. */
export interface ChatListRow {
  chat: ChatRow;
  groupIds: string[];
  memberCount: number;
  /** The reader's (or the asked person's) membership, if any. */
  membership: {
    status: ChatMemberStatus;
    push: ChatPushSetting;
    lastReadMessageId: string | null;
  } | null;
  unreadCount: number;
  lastMessage: MessageRow | null;
  /** Direct messages: the other member. */
  counterpartId: string | null;
}

const UNREAD_CAP = 99;

/**
 * The chats' list columns for `personId`: groups, member count, their
 * membership, unread messages (capped), the latest message (by
 * chats.last_message_id: one partition), the other person of a direct message.
 */
async function listColumns(tx: Tx, chatRows: ChatRow[], personId: string): Promise<ChatListRow[]> {
  if (chatRows.length === 0) return [];
  const ids = chatRows.map((c) => c.id);
  const lastIds = chatRows.map((c) => c.lastMessageId).filter((id): id is string => id !== null);
  const { rows } = await tx.execute<{
    chat_id: string;
    group_ids: string[];
    member_count: number;
    status: ChatMemberStatus | null;
    push: ChatPushSetting | null;
    last_read_message_id: string | null;
    unread: number;
    counterpart_id: string | null;
  }>(sql`
    SELECT c.id AS chat_id,
      coalesce((SELECT array_agg(g.group_id ORDER BY g.group_id) FROM public.chat_groups g
                WHERE g.chat_id = c.id), '{}') AS group_ids,
      (SELECT count(*)::int FROM public.chat_members m WHERE m.chat_id = c.id AND m.status = 'active')
        AS member_count,
      me.status, me.push, me.last_read_message_id,
      CASE WHEN me.status = 'active' THEN (
        SELECT count(*)::int FROM (
          SELECT 1 FROM public.chat_messages x
          WHERE x.chat_id = c.id AND x.id > coalesce(me.last_read_message_id, ${NIL}::uuid)
            AND x.kind = 'text' AND x.hidden_at IS NULL
            AND x.sender_person_id IS DISTINCT FROM ${personId}::uuid
          LIMIT ${UNREAD_CAP}) u)
      ELSE 0 END AS unread,
      CASE WHEN c.kind = 'direct' THEN (
        SELECT o.person_id FROM public.chat_members o
        WHERE o.chat_id = c.id AND o.person_id <> ${personId}::uuid ORDER BY o.joined_at LIMIT 1)
      END AS counterpart_id
    FROM public.chats c
    LEFT JOIN public.chat_members me ON me.chat_id = c.id AND me.person_id = ${personId}::uuid
      AND me.status <> 'left'
    WHERE c.id = ANY(${uuidArray(ids)}::uuid[])`);
  const last = lastIds.length
    ? await tx.execute<MessageRowSql>(sql`
        SELECT * FROM public.chat_messages WHERE id = ANY(${uuidArray(lastIds)}::uuid[])`)
    : { rows: [] as MessageRowSql[] };
  const lastById = new Map(last.rows.map((r) => [r.id, toMessage(r)]));
  const byId = new Map(rows.map((r) => [r.chat_id, r]));
  return chatRows.map((chat) => {
    const r = byId.get(chat.id);
    return {
      chat,
      groupIds: r?.group_ids ?? [],
      memberCount: r?.member_count ?? 0,
      membership:
        r?.status && r.push
          ? { status: r.status, push: r.push, lastReadMessageId: r.last_read_message_id }
          : null,
      unreadCount: r?.unread ?? 0,
      lastMessage: chat.lastMessageId ? (lastById.get(chat.lastMessageId) ?? null) : null,
      counterpartId: r?.counterpart_id ?? null,
    };
  });
}

type MessageRowSql = {
  id: string;
  club_id: string;
  chat_id: string;
  sender_person_id: string | null;
  kind: "text" | "system";
  body: string;
  event: { type: ChatSystemEvent; personIds: string[] } | null;
  reply_to_message_id: string | null;
  edited_at: Date | string | null;
  hidden_at: Date | string | null;
  hidden_by_person_id: string | null;
  hidden_reason: "sender" | "moderator" | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const date = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const dateOrNull = (v: Date | string | null) => (v === null ? null : date(v));

function toMessage(r: MessageRowSql): MessageRow {
  return {
    id: r.id,
    clubId: r.club_id,
    chatId: r.chat_id,
    senderPersonId: r.sender_person_id,
    kind: r.kind,
    body: r.body,
    event: r.event,
    replyToMessageId: r.reply_to_message_id,
    editedAt: dateOrNull(r.edited_at),
    hiddenAt: dateOrNull(r.hidden_at),
    hiddenByPersonId: r.hidden_by_person_id,
    hiddenReason: r.hidden_reason,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

// --- Lists ------------------------------------------------------------------------

/**
 * "Mina kanaler": a page of the person's chats across clubs, newest activity
 * first, keyset on the chat ID. Outside a club context: the person's own
 * memberships and their chats (member_read policies,
 * chat_members_person_idx); the list columns are read per club.
 */
export async function myChatPage(
  tx: Tx,
  personId: string,
  page: { cursor: string | null; limit: number },
): Promise<{ rows: { chatId: string; clubId: string }[]; cursorFound: boolean }> {
  const { rows } = await tx.execute<{ id: string; club_id: string; found: boolean }>(sql`
    WITH mine AS (
      SELECT c.id, c.club_id, coalesce(c.last_message_at, c.created_at) AS at
      FROM public.chat_members cm JOIN public.chats c ON c.id = cm.chat_id
      WHERE cm.person_id = ${personId}::uuid AND cm.status <> 'left'),
    cur AS (SELECT at, id FROM mine WHERE id = ${page.cursor}::uuid)
    SELECT m.id, m.club_id, EXISTS (SELECT 1 FROM cur) AS found FROM mine m
    WHERE ${page.cursor}::uuid IS NULL OR (m.at, m.id) < (SELECT cur.at, cur.id FROM cur)
    ORDER BY m.at DESC, m.id DESC
    LIMIT ${page.limit}`);
  if (page.cursor && rows.length > 0 && !rows[0]!.found) return { rows: [], cursorFound: false };
  return { rows: rows.map((r) => ({ chatId: r.id, clubId: r.club_id })), cursorFound: true };
}

/** Chats of one club with their list columns for the person (in the club's context). */
export async function chatListRows(
  tx: Tx,
  chatIds: readonly string[],
  personId: string,
): Promise<ChatListRow[]> {
  if (chatIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(chats)
    .where(sql`${chats.id} = ANY(${uuidArray(chatIds)}::uuid[])`);
  return listColumns(tx, rows, personId);
}

/** A group's chats (chat_groups_group_idx), for the reader to filter by policy. */
export async function groupChats(
  tx: Tx,
  groupId: string,
  personId: string,
): Promise<ChatListRow[]> {
  const rows = await tx
    .select({ chat: chats })
    .from(chatGroups)
    .innerJoin(chats, eq(chats.id, chatGroups.chatId))
    .where(eq(chatGroups.groupId, groupId))
    .orderBy(sql`${chats.defaultForGroupId} IS NULL`, chats.name, chats.id);
  return listColumns(
    tx,
    rows.map((r) => r.chat),
    personId,
  );
}

/** The club's channels without groups (club channels). */
export async function clubChannels(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ChatListRow[]> {
  const rows = await tx
    .select()
    .from(chats)
    .where(
      sql`${chats.clubId} = ${clubId} AND ${chats.kind} = 'channel'
        AND NOT EXISTS (SELECT 1 FROM public.chat_groups g WHERE g.chat_id = ${chats.id})`,
    )
    .orderBy(chats.name, chats.id);
  return listColumns(tx, rows, personId);
}

export async function chatListRow(
  tx: Tx,
  chatId: string,
  personId: string,
): Promise<ChatListRow | null> {
  const [row] = await tx.select().from(chats).where(eq(chats.id, chatId));
  if (!row) return null;
  return (await listColumns(tx, [row], personId))[0] ?? null;
}

/** Chat IDs the person is in (active or offered), with their clubs: the real-time connection. */
export async function chatIdsOfPerson(
  tx: Tx,
  personId: string,
): Promise<{ chatId: string; clubId: string; status: ChatMemberStatus }[]> {
  const rows = await tx
    .select({ chatId: chatMembers.chatId, clubId: chatMembers.clubId, status: chatMembers.status })
    .from(chatMembers)
    .where(and(eq(chatMembers.personId, personId), sql`${chatMembers.status} <> 'left'`));
  return rows;
}

// --- Chats and members --------------------------------------------------------------

export async function findChat(tx: Tx, chatId: string): Promise<ChatRow | null> {
  const [row] = await tx.select().from(chats).where(eq(chats.id, chatId));
  return row ?? null;
}

export async function lockChat(tx: Tx, chatId: string): Promise<ChatRow | null> {
  const [row] = await tx.select().from(chats).where(eq(chats.id, chatId)).for("update");
  return row ?? null;
}

export async function insertChat(
  tx: Tx,
  row: typeof chats.$inferInsert,
  groupIds: readonly string[],
): Promise<ChatRow> {
  const [chat] = await tx.insert(chats).values(row).returning();
  if (groupIds.length > 0) {
    await tx
      .insert(chatGroups)
      .values(groupIds.map((groupId) => ({ clubId: row.clubId, chatId: chat!.id, groupId })));
  }
  return chat!;
}

export async function updateChat(
  tx: Tx,
  chatId: string,
  values: Partial<typeof chats.$inferInsert>,
): Promise<ChatRow> {
  const [row] = await tx.update(chats).set(values).where(eq(chats.id, chatId)).returning();
  return row!;
}

/** Members (not left) with what everyone in the chat sees about them. */
export async function members(
  tx: Tx,
  chatId: string,
): Promise<(ChatMemberRow & { child: boolean; leader: boolean; guardianOf: string[] })[]> {
  const rows = await tx
    .select()
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), sql`${chatMembers.status} <> 'left'`))
    .orderBy(chatMembers.joinedAt, chatMembers.id);
  const { rows: facts } = await tx.execute<{
    person_id: string;
    child: boolean;
    leader: boolean;
    guardian_of: string[];
  }>(sql`SELECT person_id, child, leader, guardian_of FROM app.chat_member_facts(${chatId}::uuid)`);
  const byPerson = new Map(facts.map((f) => [f.person_id, f]));
  return rows.map((r) => {
    const f = byPerson.get(r.personId);
    return {
      ...r,
      child: f?.child ?? false,
      leader: f?.leader ?? false,
      guardianOf: f?.guardian_of ?? [],
    };
  });
}

export async function findMember(
  tx: Tx,
  chatId: string,
  personId: string,
): Promise<ChatMemberRow | null> {
  const [row] = await tx
    .select()
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.personId, personId)));
  return row ?? null;
}

/**
 * Adds or re-activates members (a row that left is reused: one row per
 * person keeps the chat's history of them). Returns those whose status changed.
 */
export async function upsertMembers(
  tx: Tx,
  clubId: string,
  chatId: string,
  people: readonly {
    personId: string;
    status: "active" | "offered";
    reason: ChatMemberReason;
    role?: "owner" | "member";
  }[],
  addedBy: string | null,
): Promise<{ personId: string; status: ChatMemberStatus }[]> {
  if (people.length === 0) return [];
  const rows = await tx
    .insert(chatMembers)
    .values(
      people.map((p) => ({
        clubId,
        chatId,
        personId: p.personId,
        status: p.status,
        reason: p.reason,
        role: p.role ?? "member",
        addedByPersonId: addedBy,
      })),
    )
    .onConflictDoUpdate({
      target: [chatMembers.chatId, chatMembers.personId],
      set: {
        status: sql`excluded.status`,
        reason: sql`excluded.reason`,
        addedByPersonId: sql`excluded.added_by_person_id`,
        leftAt: null,
        removedByPersonId: null,
        joinedAt: sql`now()`,
      },
      setWhere: sql`${chatMembers.status} = 'left'`,
    })
    .returning({ personId: chatMembers.personId, status: chatMembers.status });
  return rows;
}

export async function setMemberStatus(
  tx: Tx,
  chatId: string,
  personId: string,
  values: { status: ChatMemberStatus; removedByPersonId?: string | null },
): Promise<boolean> {
  const rows = await tx
    .update(chatMembers)
    .set({
      status: values.status,
      leftAt: values.status === "left" ? sql`now()` : null,
      ...(values.removedByPersonId !== undefined
        ? { removedByPersonId: values.removedByPersonId }
        : {}),
      ...(values.status === "active" ? { joinedAt: sql`now()` } : {}),
    })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.personId, personId)))
    .returning({ id: chatMembers.id });
  return rows.length > 0;
}

export async function setPush(
  tx: Tx,
  chatId: string,
  personId: string,
  push: ChatPushSetting,
): Promise<boolean> {
  const rows = await tx
    .update(chatMembers)
    .set({ push })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.personId, personId)))
    .returning({ id: chatMembers.id });
  return rows.length > 0;
}

/** Moves the read pointer forward only. */
export async function markRead(
  tx: Tx,
  chatId: string,
  personId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await tx
    .update(chatMembers)
    .set({ lastReadMessageId: messageId, lastReadAt: sql`now()` })
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.personId, personId),
        sql`(${chatMembers.lastReadMessageId} IS NULL OR ${chatMembers.lastReadMessageId} < ${messageId}::uuid)`,
      ),
    )
    .returning({ id: chatMembers.id });
  return rows.length > 0;
}

/** The guardian rule (app.chat_enforce_guardians): who was added, offered or removed. */
export async function enforceGuardians(
  tx: Tx,
  chatId: string,
): Promise<{ personId: string; change: "added" | "offered" | "removed" }[]> {
  const { rows } = await tx.execute<{ person_id: string; change: "added" | "offered" | "removed" }>(
    sql`SELECT person_id, change FROM app.chat_enforce_guardians(${chatId}::uuid)`,
  );
  return rows.map((r) => ({ personId: r.person_id, change: r.change }));
}

/**
 * The group's default channel, created on first use (app.chat_sync_group);
 * after that its members follow the group through the worker (chat:sync_person).
 */
export async function ensureGroupChannel(tx: Tx, groupId: string): Promise<void> {
  const existing = await tx
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.defaultForGroupId, groupId));
  if (existing.length === 0) await syncGroup(tx, groupId);
}

/** The group's default channel (app.chat_sync_group): created on first use. */
export async function syncGroup(tx: Tx, groupId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string | null }>(
    sql`SELECT app.chat_sync_group(${groupId}::uuid) AS id`,
  );
  return rows[0]?.id ?? null;
}

export async function directRefusal(tx: Tx, from: string, to: string): Promise<string | null> {
  const { rows } = await tx.execute<{ reason: string | null }>(
    sql`SELECT app.chat_direct_refusal(${from}::uuid, ${to}::uuid) AS reason`,
  );
  return rows[0]?.reason ?? null;
}

export async function unaddable(
  tx: Tx,
  chatId: string,
  by: string,
  people: readonly string[],
): Promise<string[]> {
  const { rows } = await tx.execute<{ refused: string[] }>(
    sql`SELECT app.chat_unaddable(${chatId}::uuid, ${by}::uuid, ${uuidArray(people)}::uuid[]) AS refused`,
  );
  return rows[0]?.refused ?? [];
}

/** Whether the people have protected identity (global or in the club): they are offered, not added. */
export async function protectedAmong(
  tx: Tx,
  clubId: string,
  people: readonly string[],
): Promise<Set<string>> {
  if (people.length === 0) return new Set();
  const { rows } = await tx.execute<{ ids: string[] }>(sql`
    SELECT app.chat_protected_people(${clubId}::uuid, ${uuidArray(people)}::uuid[]) AS ids`);
  return new Set(rows[0]?.ids ?? []);
}

/** The existing direct chat between two people in the club, if any. */
export async function findDirect(tx: Tx, a: string, b: string): Promise<ChatRow | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT c.id FROM public.chats c
    JOIN public.chat_members x ON x.chat_id = c.id AND x.person_id = ${a}::uuid
    JOIN public.chat_members y ON y.chat_id = c.id AND y.person_id = ${b}::uuid
    WHERE c.kind = 'direct'
    ORDER BY c.id LIMIT 1`);
  return rows[0] ? findChat(tx, rows[0].id) : null;
}

// --- Messages -----------------------------------------------------------------------

/**
 * A page of messages: newest first before `cursor`, or oldest first after
 * `after` (chat_messages_chat_idx in every partition; `after` and `cursor`
 * also bound the ID range, so older partitions are pruned).
 */
export async function messages(
  tx: Tx,
  chatId: string,
  page: { cursor: string | null; after: string | null; limit: number },
): Promise<MessageRow[]> {
  const { rows } = page.after
    ? await tx.execute<MessageRowSql>(sql`
        SELECT * FROM public.chat_messages
        WHERE chat_id = ${chatId}::uuid AND id > ${page.after}::uuid
        ORDER BY id LIMIT ${page.limit}`)
    : await tx.execute<MessageRowSql>(sql`
        SELECT * FROM public.chat_messages
        WHERE chat_id = ${chatId}::uuid
          AND (${page.cursor}::uuid IS NULL OR id < ${page.cursor}::uuid)
        ORDER BY id DESC LIMIT ${page.limit}`);
  return rows.map(toMessage);
}

export async function findMessages(tx: Tx, ids: readonly string[]): Promise<MessageRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<MessageRowSql>(sql`
    SELECT * FROM public.chat_messages WHERE id = ANY(${uuidArray(ids)}::uuid[])`);
  return rows.map(toMessage);
}

export async function findMessage(tx: Tx, id: string): Promise<MessageRow | null> {
  return (await findMessages(tx, [id]))[0] ?? null;
}

/** Reactions on these messages: counts per emoji and whether the person gave it. */
export async function reactions(
  tx: Tx,
  messageIds: readonly string[],
  personId: string,
): Promise<Map<string, { emoji: string; count: number; mine: boolean }[]>> {
  const result = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
  if (messageIds.length === 0) return result;
  const { rows } = await tx.execute<{
    message_id: string;
    emoji: string;
    count: number;
    mine: boolean;
  }>(
    sql`
    SELECT message_id, emoji, count(*)::int AS count, bool_or(person_id = ${personId}::uuid) AS mine
    FROM public.chat_reactions WHERE message_id = ANY(${uuidArray(messageIds)}::uuid[])
    GROUP BY message_id, emoji ORDER BY message_id, min(created_at)`,
  );
  for (const r of rows) {
    const list = result.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine });
    result.set(r.message_id, list);
  }
  return result;
}

/** Inserts a message unless its ID exists (a resent offline message); returns the row. */
export async function insertMessage(
  tx: Tx,
  row: {
    id?: string;
    clubId: string;
    chatId: string;
    senderPersonId: string | null;
    kind: "text" | "system";
    body: string;
    event?: { type: ChatSystemEvent; personIds: string[] } | null;
    replyToMessageId?: string | null;
  },
): Promise<{ message: MessageRow; created: boolean }> {
  const inserted = await tx
    .insert(chatMessages)
    .values({
      ...(row.id ? { id: row.id } : {}),
      clubId: row.clubId,
      chatId: row.chatId,
      senderPersonId: row.senderPersonId,
      kind: row.kind,
      body: row.body,
      event: row.event ?? null,
      replyToMessageId: row.replyToMessageId ?? null,
    })
    .onConflictDoNothing({ target: chatMessages.id })
    .returning();
  if (inserted[0]) {
    await tx
      .update(chats)
      .set({ lastMessageId: inserted[0].id, lastMessageAt: inserted[0].createdAt })
      .where(
        sql`${chats.id} = ${row.chatId} AND (${chats.lastMessageId} IS NULL OR ${chats.lastMessageId} < ${inserted[0].id}::uuid)`,
      );
    return { message: inserted[0], created: true };
  }
  const existing = await findMessage(tx, row.id!);
  return { message: existing!, created: false };
}

export async function systemMessage(
  tx: Tx,
  clubId: string,
  chatId: string,
  type: ChatSystemEvent,
  personIds: readonly string[],
): Promise<MessageRow> {
  return (
    await insertMessage(tx, {
      clubId,
      chatId,
      senderPersonId: null,
      kind: "system",
      body: "",
      event: { type, personIds: [...personIds] },
    })
  ).message;
}

/** Keeps the earlier text and stores the new one (ADR 0047: every version is kept). */
export async function editMessage(tx: Tx, message: MessageRow, body: string): Promise<MessageRow> {
  await tx.insert(chatMessageVersions).values({
    clubId: message.clubId,
    messageId: message.id,
    body: message.body,
    writtenAt: message.editedAt ?? message.createdAt,
  });
  const [row] = await tx
    .update(chatMessages)
    .set({ body, editedAt: sql`now()` })
    .where(eq(chatMessages.id, message.id))
    .returning();
  return row!;
}

export async function hideMessage(
  tx: Tx,
  messageId: string,
  by: string,
  reason: "sender" | "moderator",
): Promise<MessageRow> {
  const [row] = await tx
    .update(chatMessages)
    .set({ hiddenAt: sql`now()`, hiddenByPersonId: by, hiddenReason: reason })
    .where(eq(chatMessages.id, messageId))
    .returning();
  return row!;
}

export async function versions(
  tx: Tx,
  messageId: string,
): Promise<{ body: string; writtenAt: Date }[]> {
  return tx
    .select({ body: chatMessageVersions.body, writtenAt: chatMessageVersions.writtenAt })
    .from(chatMessageVersions)
    .where(eq(chatMessageVersions.messageId, messageId))
    .orderBy(chatMessageVersions.writtenAt, chatMessageVersions.id);
}

export async function setReaction(
  tx: Tx,
  clubId: string,
  messageId: string,
  personId: string,
  emoji: string,
  on: boolean,
): Promise<boolean> {
  if (on) {
    const rows = await tx
      .insert(schema.chatReactions)
      .values({ clubId, messageId, personId, emoji })
      .onConflictDoNothing()
      .returning({ id: schema.chatReactions.id });
    return rows.length > 0;
  }
  const rows = await tx
    .delete(schema.chatReactions)
    .where(
      and(
        eq(schema.chatReactions.messageId, messageId),
        eq(schema.chatReactions.personId, personId),
        eq(schema.chatReactions.emoji, emoji),
      ),
    )
    .returning({ id: schema.chatReactions.id });
  return rows.length > 0;
}

/** Active members of chats (the real-time "chats changed" signal). */
export async function activeMemberIds(tx: Tx, chatId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: chatMembers.personId })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), sql`${chatMembers.status} <> 'left'`));
  return rows.map((r) => r.personId);
}
