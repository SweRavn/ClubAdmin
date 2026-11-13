// SPDX-License-Identifier: AGPL-3.0-only
// Child safety in chat (P2.1 part B, ADR 0047 rules 7 and 11).
//
// - Reports: one tap by a member of the chat (or a guardian of a child in
//   it); the club's safeguarding officers are told; the reported person
//   never learns who reported.
// - Cases: the officers see the report, not the chat. Reading the chat
//   needs a second officer to confirm (two-person rule); both may then read
//   for CHAT_REPORT_READ_HOURS, and every read is an audit event.
// - Moderation: officers hide messages of a chat they read for a case and
//   mute a member in the club's chats for a time; a chat's managers hide
//   messages in their chats (the chat service). The person is told; every
//   act is audited.

import { audit, type Database, outbox, type TenantContext } from "@clubadmin/db";
import {
  CHAT_REPORT_READ_HOURS,
  CHAT_REPORT_REQUEST_HOURS,
  type ChatReportsQuery,
  type CloseChatReportInput,
  type MuteChatMemberInput,
  type ReportChatInput,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import type { ChatResource } from "../authorization/index.ts";
import type { RealtimePublisher } from "../realtime/index.ts";
import * as chatRepo from "./chat.repository.ts";
import type { MessagePage } from "./chat.service.ts";
import * as repo from "./safeguarding.repository.ts";

export type { MuteRow, ReadRow, ReportRow } from "./safeguarding.repository.ts";

export interface ReportCase {
  report: repo.ReportRow;
  reads: repo.ReadRow[];
  canRead: boolean;
  /** An open request by someone else that the caller may confirm. */
  canConfirm: string | null;
}

export class SafeguardingService {
  private readonly db: Database;
  private readonly publisher: RealtimePublisher;

  constructor(db: Database, deps: { publisher: RealtimePublisher }) {
    this.db = db;
    this.publisher = deps.publisher;
  }

  /**
   * Reports a chat or one of its messages. Members report what they read;
   * a guardian of a child in the chat (who does not read it) reports the
   * chat. Repeated reports of the same message by the same person are one.
   */
  async report(
    context: TenantContext,
    chat: ChatResource,
    input: ReportChatInput,
  ): Promise<string> {
    const personId = actorPersonId(context);
    const member = chat.membership === "active";
    if (!member && chat.wardMembers.length === 0) throw new DomainError("chat_not_a_member");
    if (input.messageId && !member) throw new DomainError("chat_not_a_member");
    return this.db.withTenant(context, async (tx) => {
      let reported: string | null = null;
      if (input.messageId) {
        const message = await chatRepo.findMessage(tx, input.messageId);
        if (!message || message.chatId !== chat.chatId || message.kind !== "text") {
          throw new DomainError("not_found");
        }
        if (message.senderPersonId === personId) throw new DomainError("chat_report_own");
        reported = message.senderPersonId;
      }
      const id = await repo.insertReport(tx, {
        clubId: context.clubId,
        chatId: chat.chatId,
        messageId: input.messageId ?? null,
        reporterPersonId: personId,
        reportedPersonId: reported,
        reason: input.reason,
        note: input.note ?? null,
      });
      await audit.record(tx, {
        action: "chat.report.created",
        resourceType: "chat_report",
        resourceId: id,
        changedFields: ["reason", ...(input.messageId ? ["message_id"] : [])],
      });
      await outbox.publish(tx, "chat.report.created", { clubId: context.clubId, reportId: id });
      return id;
    });
  }

  reports(
    context: TenantContext,
    query: ChatReportsQuery,
  ): Promise<{ rows: repo.ReportRow[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.reports(tx, context.clubId, {
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return { rows: items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  async case(context: TenantContext, reportId: string): Promise<ReportCase> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const report = await repo.findReport(tx, reportId);
      if (!report || report.clubId !== context.clubId) throw new DomainError("not_found");
      const reads = await repo.reads(tx, reportId);
      const now = Date.now();
      const canRead = reads.some(
        (r) =>
          r.expiresAt !== null &&
          r.expiresAt.getTime() > now &&
          (r.requestedByPersonId === personId || r.confirmedByPersonId === personId),
      );
      const open = reads.find(
        (r) =>
          r.confirmedAt === null &&
          r.requestedByPersonId !== personId &&
          r.createdAt.getTime() > now - CHAT_REPORT_REQUEST_HOURS * 3_600_000,
      );
      return { report, reads, canRead, canConfirm: open?.id ?? null };
    });
  }

  /** Asks to read the reported chat; another safeguarding officer must confirm. */
  async requestRead(context: TenantContext, reportId: string): Promise<string> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const report = await repo.lockReport(tx, reportId);
      if (!report) throw new DomainError("not_found");
      const now = Date.now();
      const mine = (await repo.reads(tx, reportId)).find(
        (r) =>
          r.requestedByPersonId === personId &&
          ((r.confirmedAt === null &&
            r.createdAt.getTime() > now - CHAT_REPORT_REQUEST_HOURS * 3_600_000) ||
            (r.expiresAt !== null && r.expiresAt.getTime() > now)),
      );
      if (mine) return mine.id;
      const id = await repo.insertRead(tx, context.clubId, reportId, personId);
      await audit.record(tx, {
        action: "chat.report.read_requested",
        resourceType: "chat_report",
        resourceId: reportId,
      });
      await outbox.publish(tx, "chat.report.read_requested", {
        clubId: context.clubId,
        reportId,
        readId: id,
      });
      return id;
    });
  }

  /** The second safeguarding officer confirms (never the one who asked). */
  async confirmRead(context: TenantContext, reportId: string, readId: string): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const confirmed = await repo.confirmRead(
        tx,
        readId,
        reportId,
        personId,
        CHAT_REPORT_READ_HOURS,
        CHAT_REPORT_REQUEST_HOURS,
      );
      if (!confirmed) throw new DomainError("chat_read_not_confirmable");
      await audit.record(tx, {
        action: "chat.report.read_confirmed",
        resourceType: "chat_report",
        resourceId: reportId,
      });
    });
  }

  /**
   * The reported chat's messages for an officer with a confirmed read,
   * hidden texts included (the record). Every page read is logged.
   */
  async messages(
    context: TenantContext,
    reportId: string,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<MessagePage & { chatId: string }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const report = await repo.findReport(tx, reportId);
      if (!report) throw new DomainError("not_found");
      if (!(await repo.mayRead(tx, reportId, personId))) {
        throw new DomainError("chat_read_not_confirmed");
      }
      const rows = await chatRepo.messages(tx, report.chatId, {
        cursor: query.cursor ?? null,
        after: null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const replyIds = [
        ...new Set(items.map((m) => m.replyToMessageId).filter((id): id is string => !!id)),
      ];
      const replies = new Map(
        (await chatRepo.findMessages(tx, replyIds))
          .filter((m) => m.chatId === report.chatId)
          .map((m) => [m.id, m]),
      );
      await audit.record(tx, {
        action: "chat.report.read",
        resourceType: "chat_report",
        resourceId: reportId,
      });
      return {
        chatId: report.chatId,
        items,
        replies,
        reactions: await chatRepo.reactions(
          tx,
          items.map((m) => m.id),
          personId,
        ),
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** Hides a message of the reported chat (an officer with a confirmed read). */
  async hide(context: TenantContext, reportId: string, messageId: string): Promise<void> {
    const personId = actorPersonId(context);
    const hidden = await this.db.withTenant(context, async (tx) => {
      const report = await repo.findReport(tx, reportId);
      if (!report) throw new DomainError("not_found");
      if (!(await repo.mayRead(tx, reportId, personId))) {
        throw new DomainError("chat_read_not_confirmed");
      }
      const message = await chatRepo.findMessage(tx, messageId);
      if (!message || message.chatId !== report.chatId || message.kind !== "text") {
        throw new DomainError("not_found");
      }
      if (message.hiddenReason === "moderator") return null;
      await chatRepo.hideMessage(tx, messageId, personId, "moderator");
      await audit.record(tx, {
        action: "chat.message.moderated",
        resourceType: "chat_message",
        resourceId: messageId,
        changedFields: ["hidden_at"],
      });
      await outbox.publish(tx, "chat.message.moderated", {
        clubId: context.clubId,
        chatId: report.chatId,
        messageId,
        personId: message.senderPersonId!,
      });
      return report.chatId;
    });
    if (hidden) {
      await this.publisher.toChat(hidden, {
        type: "message.updated",
        clubId: context.clubId,
        chatId: hidden,
        messageId,
      });
    }
  }

  async close(
    context: TenantContext,
    reportId: string,
    input: CloseChatReportInput,
  ): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const report = await repo.lockReport(tx, reportId);
      if (!report) throw new DomainError("not_found");
      if (report.status === "closed") throw new DomainError("chat_report_closed");
      await repo.closeReport(tx, reportId, personId, input.outcome, input.note ?? null);
      await audit.record(tx, {
        action: "chat.report.closed",
        resourceType: "chat_report",
        resourceId: reportId,
        changedFields: ["status", "outcome"],
      });
    });
  }

  // --- Mutes ----------------------------------------------------------------

  /** Mutes a member in the club's chats (a longer mute replaces a shorter one). */
  async mute(context: TenantContext, input: MuteChatMemberInput): Promise<string> {
    const personId = actorPersonId(context);
    if (input.personId === personId) throw new DomainError("chat_self");
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.inClubChats(tx, context.clubId, input.personId))) {
        throw new DomainError("not_found");
      }
      if (input.reportId && !(await repo.findReport(tx, input.reportId))) {
        throw new DomainError("not_found");
      }
      const current = await repo.activeMute(tx, context.clubId, input.personId);
      if (current) await repo.liftMute(tx, current.id, personId);
      const id = await repo.insertMute(tx, {
        clubId: context.clubId,
        personId: input.personId,
        by: personId,
        reportId: input.reportId ?? null,
        hours: input.hours,
      });
      await audit.record(tx, {
        action: "chat.member.muted",
        resourceType: "person",
        resourceId: input.personId,
        changedFields: ["until"],
      });
      await outbox.publish(tx, "chat.member.muted", {
        clubId: context.clubId,
        muteId: id,
        personId: input.personId,
      });
      return id;
    });
  }

  async unmute(context: TenantContext, muteId: string): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const muted = await repo.liftMute(tx, muteId, personId);
      if (!muted) throw new DomainError("not_found");
      await audit.record(tx, {
        action: "chat.member.unmuted",
        resourceType: "person",
        resourceId: muted,
        changedFields: ["lifted_at"],
      });
    });
  }

  mutes(context: TenantContext): Promise<repo.MuteRow[]> {
    return this.db.withTenant(context, (tx) => repo.activeMutes(tx, context.clubId));
  }
}
