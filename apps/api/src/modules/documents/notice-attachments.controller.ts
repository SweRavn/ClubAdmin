// SPDX-License-Identifier: AGPL-3.0-only
// Documents attached to the notices of activities and events (P2.2 part B,
// ADR 0049 decision 4b). Those who manage the activity or event attach
// documents they read, or upload one (stored in the notices folder of its
// group or the club, through the same scanning); being invited lets a
// person read the attached documents while they are attached. Notices only
// carry links; detaching never deletes a document.

import {
  type NoticeAttachmentList,
  NoticeAttachmentListSchema,
  type SetNoticeAttachmentsInput,
  SetNoticeAttachmentsSchema,
  type StartUploadInput,
  StartUploadSchema,
  type UploadStarted,
  UploadStartedSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  AuthorizationService,
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import { PeopleService } from "../people/index.ts";
import type { NoticeAttachments } from "./documents.service.ts";
import { DocumentsService } from "./documents.service.ts";
import { iso, loadUploaders, toDocument } from "./documents.views.ts";

const TAGS = ["documents"];
const ActivityParams = z.object({ activityId: z.uuid() });
const EventParams = z.object({ eventId: z.uuid() });

type Notice = { activityId: string } | { eventId: string };

@Controller()
export class NoticeAttachmentsController {
  private readonly documents: DocumentsService;
  private readonly authorization: AuthorizationService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    documents: DocumentsService,
    authorization: AuthorizationService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.documents = documents;
    this.authorization = authorization;
    this.people = people;
    this.presenter = presenter;
  }

  private clubOf(authz: RequestAuthorization, notice: Notice): string {
    return "activityId" in notice
      ? resourceOf(authz, "activity").clubId
      : resourceOf(authz, "event").clubId;
  }

  private manages(authz: RequestAuthorization, notice: Notice): boolean {
    return "activityId" in notice
      ? permits(authz.actor, "activity.manage", resourceOf(authz, "activity"))
      : permits(authz.actor, "event.manage", resourceOf(authz, "event"));
  }

  private async list(authz: RequestAuthorization, notice: Notice): Promise<NoticeAttachmentList> {
    const clubId = this.clubOf(authz, notice);
    const manage = this.manages(authz, notice);
    const found: NoticeAttachments = await this.documents.noticeAttachments(
      tenantContext(authz, clubId),
      notice,
      manage,
    );
    const uploaders = await loadUploaders(
      this.people,
      this.presenter,
      authz,
      clubId,
      found.items.flatMap((a) => [a.document.current, a.document.latest]),
    );
    return {
      items: found.items.map((a) => ({
        document: toDocument(a.document, uploaders),
        attachedAt: iso(a.attachedAt),
      })),
      shownTo: found.shownTo,
      canManage: manage,
    };
  }

  /** Attaching widens who reads a document: the caller must read each newly attached one. */
  private async set(
    authz: RequestAuthorization,
    notice: Notice,
    input: SetNoticeAttachmentsInput,
  ): Promise<NoticeAttachmentList> {
    const clubId = this.clubOf(authz, notice);
    const context = tenantContext(authz, clubId);
    const current = new Set(
      (await this.documents.noticeAttachments(context, notice, true)).items.map(
        (a) => a.document.id,
      ),
    );
    for (const documentId of new Set(input.documentIds)) {
      if (current.has(documentId)) continue;
      const resource = await this.authorization.documentResourceOf(authz.actor, clubId, documentId);
      if (!permits(authz.actor, "document.read", resource)) throw new ProblemError("not-found");
    }
    await this.documents.setNoticeAttachments(context, notice, input.documentIds);
    return this.list(authz, notice);
  }

  // --- Activities ---------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/attachments",
    summary: "The documents attached to an activity's notice (and to whom they are shown)",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: ActivityParams },
    response: NoticeAttachmentListSchema,
  })
  activityAttachments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
  ): Promise<NoticeAttachmentList> {
    return this.list(authz, { activityId: params.activityId });
  }

  @Endpoint({
    method: "PUT",
    path: "activities/:activityId/attachments",
    summary: "Set the documents attached to an activity's notice (detaching never deletes)",
    tags: TAGS,
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParams, body: SetNoticeAttachmentsSchema },
    response: NoticeAttachmentListSchema,
  })
  @RequiresEntitlement("documents")
  setActivityAttachments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
    @Body() body: SetNoticeAttachmentsInput,
  ): Promise<NoticeAttachmentList> {
    return this.set(authz, { activityId: params.activityId }, body);
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/attachments/uploads",
    summary: "Upload a document to an activity's notice (stored in the notices folder, scanned)",
    tags: TAGS,
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParams, body: StartUploadSchema },
    response: UploadStartedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async uploadToActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
    @Body() body: StartUploadInput,
  ): Promise<UploadStarted> {
    const notice = { activityId: params.activityId };
    const started = await this.documents.startNoticeUpload(
      tenantContext(authz, this.clubOf(authz, notice)),
      notice,
      body,
    );
    return { ...started, uploadExpiresAt: iso(started.uploadExpiresAt) };
  }

  // --- Events -------------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "events/:eventId/attachments",
    summary: "The documents attached to an event's notice (and to whom they are shown)",
    tags: TAGS,
    access: { permission: "event.read", resource: "event" },
    request: { params: EventParams },
    response: NoticeAttachmentListSchema,
  })
  eventAttachments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
  ): Promise<NoticeAttachmentList> {
    return this.list(authz, { eventId: params.eventId });
  }

  @Endpoint({
    method: "PUT",
    path: "events/:eventId/attachments",
    summary: "Set the documents attached to an event's notice (detaching never deletes)",
    tags: TAGS,
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParams, body: SetNoticeAttachmentsSchema },
    response: NoticeAttachmentListSchema,
  })
  @RequiresEntitlement("documents")
  setEventAttachments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
    @Body() body: SetNoticeAttachmentsInput,
  ): Promise<NoticeAttachmentList> {
    return this.set(authz, { eventId: params.eventId }, body);
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/attachments/uploads",
    summary: "Upload a document to an event's notice (stored in the notices folder, scanned)",
    tags: TAGS,
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParams, body: StartUploadSchema },
    response: UploadStartedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async uploadToEvent(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
    @Body() body: StartUploadInput,
  ): Promise<UploadStarted> {
    const notice = { eventId: params.eventId };
    const started = await this.documents.startNoticeUpload(
      tenantContext(authz, this.clubOf(authz, notice)),
      notice,
      body,
    );
    return { ...started, uploadExpiresAt: iso(started.uploadExpiresAt) };
  }
}
