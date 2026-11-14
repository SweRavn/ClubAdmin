// SPDX-License-Identifier: AGPL-3.0-only
// Announcements (P2.3, ADR 0053): one message from the club or a group to an
// audience, on the board, by push and/or by email.
// - A draft is kept until sent; `send` sends it now, or at `scheduledAt`
//   (the worker's `announcements:due`). Sending sets `sent_at` and publishes
//   `announcement.sent`; the worker resolves the audience into notices.
// - A group's announcements go to the group (or roles in it), never beyond;
//   the club's to anyone in the club but never public.
// - Before sending everything can change; after sending only the title,
//   body, pin and expiry (marked edited; emails already sent stay).
// - Withdrawing hides it from the board (and stops what is not delivered);
//   deleting removes it. Every change is audited.
// - Emails per club and day are limited by the operator (0: no limit).
// Controllers pass what the caller may do; the policies decided it.

import {
  type ActorContext,
  audit,
  type Database,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import type {
  AnnouncementAudienceInput,
  AnnouncementChannel,
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import { audiences } from "../documents/index.ts";
import * as repo from "./announcements.repository.ts";

export type { AnnouncementRow } from "./announcements.repository.ts";
export type AudienceEntryRow = audiences.AudienceEntryRow;

export interface BoardPage {
  pinned: repo.AnnouncementRow[];
  items: repo.AnnouncementRow[];
  nextCursor: string | null;
}

const PINNED_MAX = 10;

/** Newest first by sending time (ties by ID, both descending). */
const newestFirst = (a: repo.AnnouncementRow, b: repo.AnnouncementRow) =>
  (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0) ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export class AnnouncementsService {
  private readonly db: Database;
  private readonly emailsPerClubDay: number;

  constructor(db: Database, deps: { emailsPerClubDay: number }) {
    this.db = db;
    this.emailsPerClubDay = deps.emailsPerClubDay;
  }

  /** A new announcement of the club (groupId null) or a group: a draft, sent or scheduled. */
  create(
    context: TenantContext,
    scope: { groupId: string | null },
    input: CreateAnnouncementInput,
  ): Promise<string> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const entries = this.audienceFor(scope.groupId, input.audience);
      checkDates(input.expiresAt ?? null, input.send ? (input.scheduledAt ?? null) : null);
      if (input.send && input.channels.includes("email")) {
        await this.checkEmailLimit(tx, context.clubId, entries);
      }
      const audienceId = await audiences.createAudience(tx, context.clubId, entries);
      const id = await repo.insertAnnouncement(tx, {
        clubId: context.clubId,
        groupId: scope.groupId,
        audienceId,
        title: input.title,
        body: input.body,
        channels: input.channels,
        important: input.important,
        pinnedUntil: input.pinnedUntil ?? null,
        expiresAt: input.expiresAt ?? null,
        // A draft has no time: it is scheduled only when sent with one.
        scheduledAt: input.send ? (input.scheduledAt ?? null) : null,
        createdBy: personId,
      });
      await audit.record(tx, {
        action: "announcement.created",
        resourceType: "announcement",
        resourceId: id,
      });
      if (input.send && !input.scheduledAt) await this.sendNow(tx, context.clubId, id);
      return id;
    });
  }

  /** One announcement as the caller sees it. */
  get(
    context: TenantContext,
    id: string,
  ): Promise<{ row: repo.AnnouncementRow; audience: audiences.AudienceEntryRow[] }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findAnnouncement(tx, id, personId);
      if (!row) throw new DomainError("not_found");
      const entries = row.audienceId
        ? ((await audiences.audienceEntries(tx, [row.audienceId])).get(row.audienceId) ?? [])
        : [];
      return { row, audience: entries };
    });
  }

  /** Changes an announcement (see the rules above); `send` sends or schedules a draft. */
  update(context: TenantContext, id: string, input: UpdateAnnouncementInput): Promise<void> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findAnnouncement(tx, id, personId, true);
      if (!row) throw new DomainError("not_found");
      if (row.withdrawnAt) throw new DomainError("announcement_withdrawn");
      const changes: repo.AnnouncementChanges = {};
      if (input.title !== undefined) changes.title = input.title;
      if (input.body !== undefined) changes.body = input.body;
      if (input.pinnedUntil !== undefined) changes.pinnedUntil = input.pinnedUntil;
      if (input.expiresAt !== undefined) changes.expiresAt = input.expiresAt;
      if (row.sentAt) {
        if (
          input.audience !== undefined ||
          input.channels !== undefined ||
          input.important !== undefined ||
          input.scheduledAt !== undefined ||
          input.send !== undefined
        ) {
          throw new DomainError("announcement_already_sent");
        }
        checkDates(input.expiresAt ?? null, null);
        changes.edited = true;
        await repo.updateAnnouncement(tx, id, changes);
        await audit.record(tx, {
          action: "announcement.updated",
          resourceType: "announcement",
          resourceId: id,
        });
        return;
      }
      if (input.channels !== undefined) changes.channels = input.channels;
      if (input.important !== undefined) changes.important = input.important;
      let entries: AnnouncementAudienceInput | null = null;
      if (input.audience !== undefined && row.audienceId) {
        entries = this.audienceFor(row.groupId, input.audience);
        await audiences.replaceAudience(tx, context.clubId, row.audienceId, entries);
      }
      // Sending uses the given time (or the one it had); `send: false` makes
      // it a draft again; a scheduled one can be moved.
      const scheduledAt =
        input.scheduledAt !== undefined
          ? (input.scheduledAt ?? null)
          : (row.scheduledAt?.toISOString() ?? null);
      if (input.send === true) changes.scheduledAt = scheduledAt;
      else if (input.send === false) changes.scheduledAt = null;
      else if (row.scheduledAt && input.scheduledAt !== undefined)
        changes.scheduledAt = scheduledAt;
      checkDates(
        input.expiresAt ?? null,
        input.send === true || (row.scheduledAt && input.scheduledAt) ? scheduledAt : null,
      );
      const channels = input.channels ?? row.channels;
      if (input.send && channels.includes("email")) {
        await this.checkEmailLimit(
          tx,
          context.clubId,
          entries ?? (await this.storedEntries(tx, row.audienceId)),
        );
      }
      await repo.updateAnnouncement(tx, id, changes);
      await audit.record(tx, {
        action: "announcement.updated",
        resourceType: "announcement",
        resourceId: id,
      });
      if (input.send === true && !scheduledAt) await this.sendNow(tx, context.clubId, id);
    });
  }

  /** Withdraws an announcement: off the board, and nothing more is delivered. */
  withdraw(context: TenantContext, id: string): Promise<void> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findAnnouncement(tx, id, personId, true);
      if (!row) throw new DomainError("not_found");
      if (row.withdrawnAt) return;
      await repo.withdraw(tx, id, personId);
      await audit.record(tx, {
        action: "announcement.withdrawn",
        resourceType: "announcement",
        resourceId: id,
      });
      if (row.sentAt) {
        await outbox.publish(tx, "announcement.withdrawn", {
          clubId: context.clubId,
          announcementId: id,
        });
      }
    });
  }

  /** Deletes an announcement (its reads with it; undelivered notices are stopped). */
  remove(context: TenantContext, id: string): Promise<void> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findAnnouncement(tx, id, personId, true);
      if (!row) throw new DomainError("not_found");
      await repo.deleteAnnouncement(tx, id);
      await audit.record(tx, {
        action: "announcement.deleted",
        resourceType: "announcement",
        resourceId: id,
      });
      if (row.sentAt && !row.withdrawnAt) {
        await outbox.publish(tx, "announcement.withdrawn", {
          clubId: context.clubId,
          announcementId: id,
        });
      }
    });
  }

  /** Marks it read by the caller (and its notice in the inbox). */
  markRead(context: TenantContext, id: string): Promise<void> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, (tx) => repo.markRead(tx, context.clubId, id, personId));
  }

  /** "Anslagstavlan" across the caller's clubs and groups (outside a club). */
  myBoard(
    context: ActorContext,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<BoardPage> {
    return this.db.withActor(context, async (tx) => {
      const pinned = query.cursor
        ? []
        : (await repo.myBoard(tx, { cursor: null, limit: PINNED_MAX, pinned: true }))
            .sort(newestFirst)
            .slice(0, PINNED_MAX);
      // At most limit + 1 per club: merged here, newest first.
      const rows = (
        await repo.myBoard(tx, {
          cursor: query.cursor ?? null,
          limit: query.limit + 1,
          pinned: false,
        })
      ).sort(newestFirst);
      const items = rows.slice(0, query.limit);
      return {
        pinned,
        items,
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** A group's board (for its senders, with what is outside their own audience). */
  groupBoard(
    context: TenantContext,
    groupId: string,
    query: { cursor?: string | undefined; limit: number; manage: boolean },
  ): Promise<BoardPage> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const pinned = query.cursor
        ? []
        : await repo.groupBoard(tx, {
            groupId,
            personId,
            manage: query.manage,
            pinned: true,
            cursor: null,
            limit: PINNED_MAX,
          });
      const rows = await repo.groupBoard(tx, {
        groupId,
        personId,
        manage: query.manage,
        pinned: false,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return { pinned, items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  /** The club's (or a group's) archive: drafts, scheduled, sent and withdrawn. */
  archive(
    context: TenantContext,
    query: { groupId: string | null; cursor?: string | undefined; limit: number },
  ): Promise<{ rows: repo.AnnouncementRow[]; nextCursor: string | null }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.archive(tx, {
        clubId: context.clubId,
        groupId: query.groupId,
        personId,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return { rows: items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  /** What happened to it: counts per channel and reads (a system read of the notices). */
  recipients(context: TenantContext, id: string): ReturnType<typeof repo.recipients> {
    return this.db.withSystem("announcements:recipients", { clubId: context.clubId }, (tx) =>
      repo.recipients(tx, id),
    );
  }

  /** The composer's counts for an audience (a group's default: the group). */
  preview(
    context: TenantContext,
    input: { groupId: string | null; audience: AnnouncementAudienceInput },
  ): Promise<{ recipients: number; withEmail: number; withApp: number }> {
    return this.db.withTenant(context, (tx) =>
      repo.reach(tx, context.clubId, this.audienceFor(input.groupId, input.audience)),
    );
  }

  // --- Helpers ----------------------------------------------------------------

  /** The audience to store: the given one within the group's, or the default. */
  private audienceFor(
    groupId: string | null,
    entries: AnnouncementAudienceInput | undefined,
  ): AnnouncementAudienceInput {
    if (!entries) return groupId ? [{ kind: "group", groupId }] : [{ kind: "club" }];
    if (
      groupId &&
      !entries.every(
        (e) => (e.kind === "group" || e.kind === "group_roles") && e.groupId === groupId,
      )
    ) {
      throw new DomainError("audience_outside_group");
    }
    return entries;
  }

  private async storedEntries(
    tx: Tx,
    audienceId: string | null,
  ): Promise<AnnouncementAudienceInput> {
    if (!audienceId) return [{ kind: "club" }];
    const rows = (await audiences.audienceEntries(tx, [audienceId])).get(audienceId) ?? [];
    return rows.map((e) =>
      e.kind === "group"
        ? { kind: "group", groupId: e.groupId! }
        : e.kind === "group_roles"
          ? { kind: "group_roles", groupId: e.groupId!, roleIds: e.roleIds }
          : e.kind === "club_role"
            ? { kind: "club_role", roleId: e.roleIds[0]! }
            : { kind: "club" },
    );
  }

  /** Refuses email when the club's emails in 24 hours would pass the operator's limit. */
  private async checkEmailLimit(
    tx: Tx,
    clubId: string,
    entries: AnnouncementAudienceInput,
  ): Promise<void> {
    if (this.emailsPerClubDay <= 0) return;
    const sent = await repo.emailsLastDay(tx, clubId);
    const { withEmail } = await repo.reach(tx, clubId, entries);
    if (sent + withEmail > this.emailsPerClubDay) {
      throw new DomainError("announcement_email_limit");
    }
  }

  private async sendNow(tx: Tx, clubId: string, id: string): Promise<void> {
    await repo.updateAnnouncement(tx, id, { sent: true, scheduledAt: null });
    await audit.record(tx, {
      action: "announcement.published",
      resourceType: "announcement",
      resourceId: id,
    });
    await outbox.publish(tx, "announcement.sent", { clubId, announcementId: id });
  }
}

/** The expiry is in the future, and so is a schedule. */
function checkDates(expiresAt: string | null, scheduledAt: string | null): void {
  const now = Date.now();
  if (expiresAt && Date.parse(expiresAt) <= now) throw new DomainError("announcement_expiry_past");
  if (scheduledAt && Date.parse(scheduledAt) <= now) {
    throw new DomainError("announcement_schedule_past");
  }
}

export type { AnnouncementChannel };
