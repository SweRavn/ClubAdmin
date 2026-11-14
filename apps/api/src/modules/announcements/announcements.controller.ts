// SPDX-License-Identifier: AGPL-3.0-only
// Announcements (P2.3, ADR 0053): "Anslagstavlan" across the caller's clubs
// and groups, a group's board, one announcement and marking it read (all by
// its audience: announcement.read); writing, scheduling, editing,
// withdrawing and deleting (club.announcements.send for the club's,
// group.announcements.send or owning the group for a group's,
// announcement.manage after that); the archive, the composer's counts and
// what happened to a sent one (counts only, never names). Senders go
// through the PersonPresenter.

import {
  type Announcement,
  type AnnouncementArchive,
  AnnouncementArchiveSchema,
  type AnnouncementBoard,
  type AnnouncementBoardQuery,
  AnnouncementBoardQuerySchema,
  AnnouncementBoardSchema,
  AnnouncementCreatedSchema,
  type AnnouncementDetail,
  AnnouncementDetailSchema,
  AnnouncementParamsSchema,
  type AnnouncementPreview,
  type AnnouncementPreviewInput,
  AnnouncementPreviewInputSchema,
  AnnouncementPreviewSchema,
  type AnnouncementRecipients,
  AnnouncementRecipientsSchema,
  ClubParamsSchema,
  type CreateAnnouncementInput,
  CreateAnnouncementSchema,
  GroupAnnouncementsParamsSchema,
  type PersonSummary,
  type UpdateAnnouncementInput,
  UpdateAnnouncementSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { statusOf } from "./announcements.repository.ts";
import { type AnnouncementRow, AnnouncementsService } from "./announcements.service.ts";

const TAGS = ["announcements"];
const ArchiveQuerySchema = AnnouncementBoardQuerySchema;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toAnnouncement(
  row: AnnouncementRow,
  senders: Map<string, PersonSummary>,
  canManage: boolean,
): Announcement {
  const now = Date.now();
  return {
    id: row.id,
    clubId: row.clubId,
    clubName: row.clubName,
    groupId: row.groupId,
    groupName: row.groupName,
    title: row.title,
    body: row.body,
    channels: row.channels,
    important: row.important,
    status: statusOf(row),
    pinned: row.pinnedUntil !== null && row.pinnedUntil.getTime() > now,
    pinnedUntil: iso(row.pinnedUntil),
    expiresAt: iso(row.expiresAt),
    scheduledAt: iso(row.scheduledAt),
    sentAt: iso(row.sentAt),
    editedAt: iso(row.editedAt),
    sender: (row.createdByPersonId && senders.get(row.createdByPersonId)) || null,
    read: row.read,
    canManage,
  };
}

@Controller()
export class AnnouncementsController {
  private readonly announcements: AnnouncementsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    announcements: AnnouncementsService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.announcements = announcements;
    this.people = people;
    this.presenter = presenter;
  }

  /** The senders the caller may see, per club (each club's view of its members). */
  private async senders(
    authz: RequestAuthorization,
    rows: readonly AnnouncementRow[],
  ): Promise<Map<string, PersonSummary>> {
    const byClub = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.createdByPersonId) continue;
      const ids = byClub.get(r.clubId) ?? new Set<string>();
      ids.add(r.createdByPersonId);
      byClub.set(r.clubId, ids);
    }
    const out = new Map<string, PersonSummary>();
    for (const [clubId, ids] of byClub) {
      const summaries = await this.people.summaries(tenantContext(authz, clubId), [...ids]);
      for (const p of await this.presenter.present(authz, clubId, summaries)) out.set(p.id, p);
    }
    return out;
  }

  /** Whether the caller manages a row of a list (its writer, or a sender to its scope). */
  private manages(authz: RequestAuthorization, row: AnnouncementRow, groupSender = false): boolean {
    if (authz.actor.onBehalfOf) return false;
    if (row.createdByPersonId === authz.actor.personId) return true;
    if (groupSender && row.groupId) return true;
    return permits(authz.actor, "club.announcements.send", { kind: "club", clubId: row.clubId });
  }

  private async board(
    authz: RequestAuthorization,
    page: { pinned: AnnouncementRow[]; items: AnnouncementRow[]; nextCursor: string | null },
    groupSender = false,
  ): Promise<AnnouncementBoard> {
    const senders = await this.senders(authz, [...page.pinned, ...page.items]);
    const pinnedIds = new Set(page.pinned.map((r) => r.id));
    return {
      pinned: page.pinned.map((r) =>
        toAnnouncement(r, senders, this.manages(authz, r, groupSender)),
      ),
      // A pinned one is shown on top, not twice.
      items: page.items
        .filter((r) => !pinnedIds.has(r.id))
        .map((r) => toAnnouncement(r, senders, this.manages(authz, r, groupSender))),
      nextCursor: page.nextCursor,
    };
  }

  // --- Reading ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/announcements",
    summary:
      "Anslagstavlan: pinned announcements, then the newest of the caller's clubs and groups",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: AnnouncementBoardQuerySchema },
    response: AnnouncementBoardSchema,
  })
  async myBoard(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: AnnouncementBoardQuery,
  ): Promise<AnnouncementBoard> {
    return this.board(authz, await this.announcements.myBoard(authz.context, query));
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/announcements",
    summary: "A group's board: pinned, then the newest the caller reads",
    tags: TAGS,
    access: { permission: "group.announcements.read", resource: "group" },
    request: { params: GroupAnnouncementsParamsSchema, query: AnnouncementBoardQuerySchema },
    response: AnnouncementBoardSchema,
  })
  async groupBoard(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: AnnouncementBoardQuery,
  ): Promise<AnnouncementBoard> {
    const manage = permits(authz.actor, "group.announcements.send", resourceOf(authz, "group"));
    const page = await this.announcements.groupBoard(
      tenantContext(authz, params.clubId),
      params.groupId,
      { ...query, manage },
    );
    return this.board(authz, page, manage);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/announcements/:announcementId",
    summary: "One announcement, with to whom it goes (groups and roles, never names)",
    tags: TAGS,
    access: { permission: "announcement.read", resource: "announcement" },
    request: { params: AnnouncementParamsSchema },
    response: AnnouncementDetailSchema,
  })
  async get(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
  ): Promise<AnnouncementDetail> {
    const manage = permits(authz.actor, "announcement.manage", resourceOf(authz, "announcement"));
    const { row, audience } = await this.announcements.get(
      tenantContext(authz, params.clubId),
      params.announcementId,
    );
    const senders = await this.senders(authz, [row]);
    return {
      announcement: toAnnouncement(row, senders, manage),
      audience: audience.map((e) => ({
        kind: e.kind,
        groupId: e.groupId,
        groupName: e.groupName,
        roleIds: e.roleIds,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/announcements/:announcementId/read",
    summary: "The caller read the announcement (its notice in the inbox too)",
    tags: TAGS,
    access: { permission: "announcement.read", resource: "announcement" },
    request: { params: AnnouncementParamsSchema },
    response: z.null(),
    status: 204,
  })
  async read(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
  ): Promise<null> {
    // A guardian acting for a ward reads as themselves: the mark is the caller's.
    await this.announcements.markRead(tenantContext(authz, params.clubId), params.announcementId);
    return null;
  }

  // --- Writing ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/announcements",
    summary: "The club's archive: drafts, scheduled, sent and withdrawn, newest first",
    tags: TAGS,
    access: { permission: "club.announcements.send", resource: "club" },
    request: { params: ClubParamsSchema, query: ArchiveQuerySchema },
    response: AnnouncementArchiveSchema,
  })
  async archive(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: AnnouncementBoardQuery,
  ): Promise<AnnouncementArchive> {
    const page = await this.announcements.archive(tenantContext(authz, params.clubId), {
      groupId: null,
      ...query,
    });
    const senders = await this.senders(authz, page.rows);
    return {
      items: page.rows.map((r) => toAnnouncement(r, senders, true)),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/announcements/archive",
    summary: "A group's archive for its senders: drafts, scheduled, sent and withdrawn",
    tags: TAGS,
    access: { permission: "group.announcements.send", resource: "group" },
    request: { params: GroupAnnouncementsParamsSchema, query: ArchiveQuerySchema },
    response: AnnouncementArchiveSchema,
  })
  async groupArchive(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: AnnouncementBoardQuery,
  ): Promise<AnnouncementArchive> {
    const page = await this.announcements.archive(tenantContext(authz, params.clubId), {
      groupId: params.groupId,
      ...query,
    });
    const senders = await this.senders(authz, page.rows);
    return {
      items: page.rows.map((r) => toAnnouncement(r, senders, true)),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/announcements",
    summary: "Write an announcement of the club (default audience: the whole club)",
    tags: TAGS,
    access: { permission: "club.announcements.send", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateAnnouncementSchema },
    response: AnnouncementCreatedSchema,
    status: 201,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateAnnouncementInput,
  ): Promise<{ id: string }> {
    const id = await this.announcements.create(
      tenantContext(authz, params.clubId),
      { groupId: null },
      body,
    );
    return { id };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/announcements",
    summary: "Write an announcement of a group (to the group or roles in it)",
    tags: TAGS,
    access: { permission: "group.announcements.send", resource: "group" },
    request: { params: GroupAnnouncementsParamsSchema, body: CreateAnnouncementSchema },
    response: AnnouncementCreatedSchema,
    status: 201,
  })
  async createForGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: CreateAnnouncementInput,
  ): Promise<{ id: string }> {
    const id = await this.announcements.create(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      body,
    );
    return { id };
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/announcements/:announcementId",
    summary: "Change, send or schedule an announcement (after sending: text, pin and expiry only)",
    tags: TAGS,
    access: { permission: "announcement.manage", resource: "announcement" },
    request: { params: AnnouncementParamsSchema, body: UpdateAnnouncementSchema },
    response: z.null(),
    status: 204,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
    @Body() body: UpdateAnnouncementInput,
  ): Promise<null> {
    await this.announcements.update(
      tenantContext(authz, params.clubId),
      params.announcementId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/announcements/:announcementId/withdraw",
    summary: "Withdraw an announcement: off the board, nothing more is delivered",
    tags: TAGS,
    access: { permission: "announcement.manage", resource: "announcement" },
    request: { params: AnnouncementParamsSchema },
    response: z.null(),
    status: 204,
  })
  async withdraw(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
  ): Promise<null> {
    await this.announcements.withdraw(tenantContext(authz, params.clubId), params.announcementId);
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/announcements/:announcementId",
    summary: "Delete an announcement",
    tags: TAGS,
    access: { permission: "announcement.manage", resource: "announcement" },
    request: { params: AnnouncementParamsSchema },
    response: z.null(),
    status: 204,
  })
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
  ): Promise<null> {
    await this.announcements.remove(tenantContext(authz, params.clubId), params.announcementId);
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/announcements/:announcementId/recipients",
    summary: "What happened to an announcement: recipients, reads and deliveries (counts only)",
    tags: TAGS,
    access: { permission: "announcement.manage", resource: "announcement" },
    request: { params: AnnouncementParamsSchema },
    response: AnnouncementRecipientsSchema,
  })
  recipients(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; announcementId: string },
  ): Promise<AnnouncementRecipients> {
    return this.announcements.recipients(
      tenantContext(authz, params.clubId),
      params.announcementId,
    );
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/announcements/preview",
    summary: "The composer's counts for an audience of the club: people, with email, with the app",
    tags: TAGS,
    access: { permission: "club.announcements.send", resource: "club" },
    request: { params: ClubParamsSchema, body: AnnouncementPreviewInputSchema },
    response: AnnouncementPreviewSchema,
    status: 200,
  })
  preview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: AnnouncementPreviewInput,
  ): Promise<AnnouncementPreview> {
    return this.announcements.preview(tenantContext(authz, params.clubId), {
      groupId: null,
      audience: body.audience,
    });
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/announcements/preview",
    summary: "The composer's counts for an audience within a group",
    tags: TAGS,
    access: { permission: "group.announcements.send", resource: "group" },
    request: { params: GroupAnnouncementsParamsSchema, body: AnnouncementPreviewInputSchema },
    response: AnnouncementPreviewSchema,
    status: 200,
  })
  groupPreview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: AnnouncementPreviewInput,
  ): Promise<AnnouncementPreview> {
    return this.announcements.preview(tenantContext(authz, params.clubId), {
      groupId: params.groupId,
      audience: body.audience,
    });
  }
}
