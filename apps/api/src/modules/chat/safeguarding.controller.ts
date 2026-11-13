// SPDX-License-Identifier: AGPL-3.0-only
// The club's safeguarding cases (P2.1 part B, ADR 0047 rules 7 and 11): the
// officers (`club.safeguarding.handle`, with a second factor) list reports,
// ask to read a reported chat and confirm each other's requests (two-person
// rule), read it (every read logged), hide messages, mute members for a
// time and close cases. People go through the PersonPresenter.

import {
  CHAT_REPORT_REQUEST_HOURS,
  type ChatMute,
  ChatMuteListSchema,
  ChatMuteParamsSchema,
  ChatMuteSchema,
  type ChatReportDetail,
  ChatReportDetailSchema,
  type ChatReportMessages,
  ChatReportMessagesSchema,
  type ChatReportPage,
  ChatReportPageSchema,
  ChatReportParamsSchema,
  ChatReportReadParamsSchema,
  type ChatReportsQuery,
  ChatReportsQuerySchema,
  type ChatReportSummary,
  type CloseChatReportInput,
  CloseChatReportSchema,
  ClubParamsSchema,
  HideReportedMessageSchema,
  type MuteChatMemberInput,
  MuteChatMemberSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import { PeopleService } from "../people/index.ts";
import { ChatPeople, peopleOfMessages, toChatMessage } from "./chat.views.ts";
import { type ReportRow, SafeguardingService } from "./safeguarding.service.ts";

const TAGS = ["safeguarding"];
const ACCESS = { permission: "club.safeguarding.handle", resource: "club" } as const;
const EmptySchema = z.object({}).openapi("Empty");
const ReadCreatedSchema = z.object({ id: z.uuid() }).openapi("ChatReportReadCreated");

const iso = (d: Date) => d.toISOString();

function toSummary(r: ReportRow, people: ChatPeople): ChatReportSummary {
  return {
    id: r.id,
    clubId: r.clubId,
    chatId: r.chatId,
    chatName: r.chatName,
    chatKind: r.chatKind,
    hasChildren: r.hasChildren,
    reason: r.reason,
    status: r.status,
    outcome: r.outcome,
    reportedPerson: people.person(r.reportedPersonId),
    createdAt: iso(r.createdAt),
    closedAt: r.closedAt ? iso(r.closedAt) : null,
  };
}

@Controller()
export class SafeguardingController {
  private readonly safeguarding: SafeguardingService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    safeguarding: SafeguardingService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.safeguarding = safeguarding;
    this.people = people;
    this.presenter = presenter;
  }

  private async peopleOf(
    authz: RequestAuthorization,
    clubId: string,
    ids: Iterable<string | null>,
  ): Promise<ChatPeople> {
    const set = new Set([...ids].filter((id): id is string => id !== null));
    const loaded = await ChatPeople.load(
      this.people,
      this.presenter,
      authz,
      new Map([[clubId, set]]),
    );
    return loaded.get(clubId)!;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/safeguarding/reports",
    summary: "The club's reports from chats, newest first (safeguarding officers)",
    tags: TAGS,
    access: ACCESS,
    request: { params: ClubParamsSchema, query: ChatReportsQuerySchema },
    response: ChatReportPageSchema,
  })
  @RequiresEntitlement("chat")
  async reports(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: ChatReportsQuery,
  ): Promise<ChatReportPage> {
    const page = await this.safeguarding.reports(tenantContext(authz, params.clubId), query);
    const people = await this.peopleOf(
      authz,
      params.clubId,
      page.rows.map((r) => r.reportedPersonId),
    );
    return { items: page.rows.map((r) => toSummary(r, people)), nextCursor: page.nextCursor };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/safeguarding/reports/:reportId",
    summary: "A report: who reported, why, the requests to read the chat and the outcome",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatReportParamsSchema },
    response: ChatReportDetailSchema,
  })
  @RequiresEntitlement("chat")
  async report(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
  ): Promise<ChatReportDetail> {
    const found = await this.safeguarding.case(
      tenantContext(authz, params.clubId),
      params.reportId,
    );
    const r = found.report;
    const people = await this.peopleOf(authz, params.clubId, [
      r.reporterPersonId,
      r.reportedPersonId,
      r.closedByPersonId,
      ...found.reads.flatMap((x) => [x.requestedByPersonId, x.confirmedByPersonId]),
    ]);
    const now = Date.now();
    return {
      report: toSummary(r, people),
      reporter: people.person(r.reporterPersonId),
      note: r.note,
      messageId: r.messageId,
      outcomeNote: r.outcomeNote,
      closedBy: people.person(r.closedByPersonId),
      reads: found.reads.map((x) => ({
        id: x.id,
        requestedBy: people.person(x.requestedByPersonId)!,
        confirmedBy: people.person(x.confirmedByPersonId),
        status:
          x.expiresAt && x.expiresAt.getTime() > now
            ? "confirmed"
            : x.confirmedAt === null &&
                x.createdAt.getTime() > now - CHAT_REPORT_REQUEST_HOURS * 3_600_000
              ? "requested"
              : "lapsed",
        requestedAt: iso(x.createdAt),
        expiresAt: x.expiresAt ? iso(x.expiresAt) : null,
      })),
      canRead: found.canRead,
      canConfirm: found.canConfirm,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/safeguarding/reports/:reportId/reads",
    summary: "Ask to read the reported chat; a second safeguarding officer must confirm",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatReportParamsSchema },
    response: ReadCreatedSchema,
  })
  @RequiresEntitlement("chat")
  async requestRead(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
  ): Promise<{ id: string }> {
    return {
      id: await this.safeguarding.requestRead(tenantContext(authz, params.clubId), params.reportId),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/safeguarding/reports/:reportId/reads/:readId/confirm",
    summary: "Confirm another safeguarding officer's request to read (two-person rule)",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatReportReadParamsSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async confirmRead(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string; readId: string },
  ): Promise<Record<string, never>> {
    await this.safeguarding.confirmRead(
      tenantContext(authz, params.clubId),
      params.reportId,
      params.readId,
    );
    return {};
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/safeguarding/reports/:reportId/messages",
    summary:
      "The reported chat's messages, hidden ones included (a confirmed read; each read is logged)",
    tags: TAGS,
    access: ACCESS,
    request: {
      params: ChatReportParamsSchema,
      query: z.object({
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    response: ChatReportMessagesSchema,
  })
  @RequiresEntitlement("chat")
  async messages(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
    @Query() query: { cursor?: string; limit: number },
  ): Promise<ChatReportMessages> {
    const page = await this.safeguarding.messages(
      tenantContext(authz, params.clubId),
      params.reportId,
      query,
    );
    const people = await this.peopleOf(authz, params.clubId, peopleOfMessages(page));
    return {
      items: page.items.map((m) => ({
        ...toChatMessage(m, page, people),
        recordBody: m.body,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/safeguarding/reports/:reportId/hide",
    summary: "Hide a message of the reported chat (kept as the record; the sender is told)",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatReportParamsSchema, body: HideReportedMessageSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async hide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
    @Body() body: { messageId: string },
  ): Promise<Record<string, never>> {
    await this.safeguarding.hide(
      tenantContext(authz, params.clubId),
      params.reportId,
      body.messageId,
    );
    return {};
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/safeguarding/reports/:reportId/close",
    summary: "Close a case with its outcome",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatReportParamsSchema, body: CloseChatReportSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async close(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
    @Body() body: CloseChatReportInput,
  ): Promise<Record<string, never>> {
    await this.safeguarding.close(tenantContext(authz, params.clubId), params.reportId, body);
    return {};
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/safeguarding/mutes",
    summary: "Members who may not write in the club's chats now",
    tags: TAGS,
    access: ACCESS,
    request: { params: ClubParamsSchema },
    response: ChatMuteListSchema,
  })
  @RequiresEntitlement("chat")
  async mutes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<{ items: ChatMute[] }> {
    const rows = await this.safeguarding.mutes(tenantContext(authz, params.clubId));
    const people = await this.peopleOf(
      authz,
      params.clubId,
      rows.flatMap((r) => [r.personId, r.mutedByPersonId]),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        person: people.person(r.personId)!,
        mutedBy: people.person(r.mutedByPersonId)!,
        until: iso(r.until),
        reportId: r.reportId,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/safeguarding/mutes",
    summary: "Mute a member in the club's chats for a time (the person is told)",
    tags: TAGS,
    access: ACCESS,
    request: { params: ClubParamsSchema, body: MuteChatMemberSchema },
    response: ChatMuteSchema.pick({ id: true }).openapi("ChatMuteCreated"),
  })
  @RequiresEntitlement("chat")
  async mute(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: MuteChatMemberInput,
  ): Promise<{ id: string }> {
    return { id: await this.safeguarding.mute(tenantContext(authz, params.clubId), body) };
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/safeguarding/mutes/:muteId",
    summary: "Lift a mute",
    tags: TAGS,
    access: ACCESS,
    request: { params: ChatMuteParamsSchema },
    response: EmptySchema,
  })
  @RequiresEntitlement("chat")
  async unmute(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; muteId: string },
  ): Promise<Record<string, never>> {
    await this.safeguarding.unmute(tenantContext(authz, params.clubId), params.muteId);
    return {};
  }
}
