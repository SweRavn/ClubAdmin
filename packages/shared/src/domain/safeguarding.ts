// SPDX-License-Identifier: AGPL-3.0-only
// Child safety in chat (P2.1 part B, ADR 0047 rules 7 and 11): reports from
// chats, the club's safeguarding cases (reading a reported chat under a
// two-person rule, every read logged), hiding reported messages and muting
// members for a time. The reported person never sees who reported; people
// appear only as PersonSummary from the presenter (ADR 0022).

import { z } from "../zod.ts";
import { ChatMessageSchema, ChatPersonSchema } from "./chat.ts";

export const ChatReportParamsSchema = z.object({ clubId: z.uuid(), reportId: z.uuid() });
export const ChatReportReadParamsSchema = ChatReportParamsSchema.extend({ readId: z.uuid() });
export const ChatMuteParamsSchema = z.object({ clubId: z.uuid(), muteId: z.uuid() });

export const CHAT_REPORT_REASONS = [
  /** Bullying, threats or harassment. */
  "bullying",
  /** Sexual or otherwise inappropriate content. */
  "inappropriate",
  /** An adult seeking private contact, secrecy, gifts (grooming signs). */
  "unsafe_contact",
  /** Someone may hurt themselves. */
  "self_harm",
  "other",
] as const;
export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number];

export const CHAT_REPORT_STATUSES = ["open", "closed"] as const;
export type ChatReportStatus = (typeof CHAT_REPORT_STATUSES)[number];

export const CHAT_REPORT_OUTCOMES = [
  "no_action",
  "message_hidden",
  "member_muted",
  /** Taken further (the club's procedure, the police or social services). */
  "referred",
] as const;
export type ChatReportOutcome = (typeof CHAT_REPORT_OUTCOMES)[number];

/** How long a confirmed read of a reported chat lasts. */
export const CHAT_REPORT_READ_HOURS = 24;
/** An unconfirmed request to read lapses after this. */
export const CHAT_REPORT_REQUEST_HOURS = 72;
/** The longest mute (30 days). */
export const CHAT_MUTE_MAX_HOURS = 720;
export const CHAT_REPORT_NOTE_MAX_LENGTH = 1000;

/** One tap: the reason is enough; the reported message is optional (a whole chat). */
export const ReportChatSchema = z
  .object({
    messageId: z.uuid().nullish(),
    reason: z.enum(CHAT_REPORT_REASONS),
    note: z.string().trim().max(CHAT_REPORT_NOTE_MAX_LENGTH).nullish(),
  })
  .strict()
  .openapi("ReportChat");
export type ReportChatInput = z.infer<typeof ReportChatSchema>;

export const ChatReportCreatedSchema = z.object({ id: z.uuid() }).openapi("ChatReportCreated");

export const ChatReportReadSchema = z.object({
  id: z.uuid(),
  requestedBy: ChatPersonSchema,
  confirmedBy: ChatPersonSchema.nullable(),
  status: z.enum(["requested", "confirmed", "lapsed"]),
  requestedAt: z.iso.datetime(),
  /** While confirmed: until when the two of them may read the chat. */
  expiresAt: z.iso.datetime().nullable(),
});

export const ChatReportSummarySchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    chatId: z.uuid(),
    chatName: z.string().nullable(),
    chatKind: z.enum(["channel", "direct"]),
    /** Children are in the chat. */
    hasChildren: z.boolean(),
    reason: z.enum(CHAT_REPORT_REASONS),
    status: z.enum(CHAT_REPORT_STATUSES),
    outcome: z.enum(CHAT_REPORT_OUTCOMES).nullable(),
    /** The sender of the reported message (none when a whole chat was reported). */
    reportedPerson: ChatPersonSchema.nullable(),
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  })
  .openapi("ChatReportSummary");
export type ChatReportSummary = z.infer<typeof ChatReportSummarySchema>;

export const ChatReportPageSchema = z
  .object({ items: z.array(ChatReportSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("ChatReportPage");
export type ChatReportPage = z.infer<typeof ChatReportPageSchema>;

export const ChatReportsQuerySchema = z.object({
  status: z.enum(CHAT_REPORT_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ChatReportsQuery = z.infer<typeof ChatReportsQuerySchema>;

export const ChatReportDetailSchema = z
  .object({
    report: ChatReportSummarySchema,
    /** Only the safeguarding officers see who reported (never the reported person). */
    reporter: ChatPersonSchema.nullable(),
    note: z.string().nullable(),
    messageId: z.uuid().nullable(),
    outcomeNote: z.string().nullable(),
    closedBy: ChatPersonSchema.nullable(),
    reads: z.array(ChatReportReadSchema),
    /** The caller may read the chat now (a confirmed read they are part of). */
    canRead: z.boolean(),
    /** A request by someone else the caller may confirm. */
    canConfirm: z.uuid().nullable(),
  })
  .openapi("ChatReportDetail");
export type ChatReportDetail = z.infer<typeof ChatReportDetailSchema>;

/** The reported chat as safeguarding officers read it: hidden texts included. */
export const ChatReportMessagesSchema = z
  .object({
    items: z.array(
      ChatMessageSchema.extend({
        /** The text, also of hidden messages (the record, ADR 0047). */
        recordBody: z.string(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("ChatReportMessages");
export type ChatReportMessages = z.infer<typeof ChatReportMessagesSchema>;

export const HideReportedMessageSchema = z
  .object({ messageId: z.uuid() })
  .strict()
  .openapi("HideReportedMessage");

export const CloseChatReportSchema = z
  .object({
    outcome: z.enum(CHAT_REPORT_OUTCOMES),
    note: z.string().trim().max(CHAT_REPORT_NOTE_MAX_LENGTH).nullish(),
  })
  .strict()
  .openapi("CloseChatReport");
export type CloseChatReportInput = z.infer<typeof CloseChatReportSchema>;

export const MuteChatMemberSchema = z
  .object({
    personId: z.uuid(),
    hours: z.number().int().min(1).max(CHAT_MUTE_MAX_HOURS),
    reportId: z.uuid().nullish(),
  })
  .strict()
  .openapi("MuteChatMember");
export type MuteChatMemberInput = z.infer<typeof MuteChatMemberSchema>;

export const ChatMuteSchema = z
  .object({
    id: z.uuid(),
    person: ChatPersonSchema,
    mutedBy: ChatPersonSchema,
    until: z.iso.datetime(),
    reportId: z.uuid().nullable(),
  })
  .openapi("ChatMute");
export type ChatMute = z.infer<typeof ChatMuteSchema>;

export const ChatMuteListSchema = z
  .object({ items: z.array(ChatMuteSchema) })
  .openapi("ChatMuteList");

/** Moderation by a channel's managers (ADR 0047 rule 11): the sender is told. */
export const ModerateChatMessageSchema = z.object({}).strict().openapi("ModerateChatMessage");
