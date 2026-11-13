// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the chat tables (P2.1), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const CHAT_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.chats", column: "created_by_person_id", clubScoped: true },
  { table: "public.chats", column: "archived_by_person_id", clubScoped: true },
  {
    table: "public.chat_members",
    column: "person_id",
    clubScoped: true,
    // One row per chat and person: the duplicate's row leaves when both are in the chat.
    open: {
      where: "{a}.status <> 'left'",
      key: ["chat_id"],
      end: { status: "'left'", left_at: "now()" },
      restore: ["status", "left_at"],
    },
  },
  { table: "public.chat_members", column: "added_by_person_id", clubScoped: true },
  { table: "public.chat_members", column: "removed_by_person_id", clubScoped: true },
  { table: "public.chat_messages", column: "sender_person_id", clubScoped: true },
  { table: "public.chat_messages", column: "hidden_by_person_id", clubScoped: true },
  { table: "public.chat_reactions", column: "person_id", clubScoped: true },
];
