// SPDX-License-Identifier: AGPL-3.0-only
// "Download my data", account deletion and ward erasure (P1.8b, ADR 0041).
// The caller's own data and their wards' (full guardians); anyone else gets
// 404. People only through the presenter. These work whatever the clubs'
// subscriptions: they are the person's rights.

import {
  type AccountDeletionPreview,
  AccountDeletionPreviewSchema,
  CreateDataExportSchema,
  type DataExport,
  DataExportDownloadSchema,
  DataExportParamsSchema,
  DataExportSchema,
  DataExportsPageSchema,
  type ErasureRequest,
  ErasureRequestSchema,
  PageQuerySchema,
  type PersonSummary,
  ScheduleAccountDeletionSchema,
  type WardErasurePreview,
  WardErasurePreviewSchema,
  WardParamsSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
} from "../authorization/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import { localeOfRequest } from "./consents.controller.ts";
import { DataExportsService } from "./data-exports.service.ts";
import type { DataExportRow, ErasureRequestRow } from "./data-rights.repository.ts";
import { ErasureService } from "./erasure.service.ts";

const EmptySchema = z.object({}).openapi("Empty");

/** The caller or a ward they are a full guardian of; 404 otherwise. */
function subjectOf(authz: RequestAuthorization, personId: string | undefined): string {
  const me = authz.actor.personId;
  const id = personId ?? me;
  if (id === me || authz.actor.isFullGuardianOf(id)) return id;
  throw new ProblemError("not-found");
}

function erasureResponse(row: ErasureRequestRow, me: string): ErasureRequest {
  return {
    id: row.id,
    personId: row.personId,
    kind: row.kind,
    status: row.status,
    scheduledFor: row.scheduledFor.toISOString(),
    includeWardIds: row.includeWardIds,
    requestedByYou: row.requestedByPersonId === me,
  };
}

@Controller("me")
export class DataRightsController {
  private readonly exports: DataExportsService;
  private readonly erasure: ErasureService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    exports: DataExportsService,
    erasure: ErasureService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.exports = exports;
    this.erasure = erasure;
    this.people = people;
    this.presenter = presenter;
  }

  private async present(
    authz: RequestAuthorization,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(authz.context, unique);
    return new Map((await this.presenter.present(authz, null, rows)).map((s) => [s.id, s]));
  }

  private async exportResponses(
    authz: RequestAuthorization,
    rows: readonly DataExportRow[],
  ): Promise<DataExport[]> {
    const people = await this.present(
      authz,
      rows.map((r) => r.subjectPersonId),
    );
    return rows.map((r) => ({
      id: r.id,
      subject: people.get(r.subjectPersonId) ?? null,
      subjectPersonId: r.subjectPersonId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.status === "ready" && r.expiresAt ? r.expiresAt.toISOString() : null,
      sizeBytes: r.sizeBytes,
      errorCode: r.errorCode,
    }));
  }

  @Endpoint({
    method: "POST",
    path: "data-exports",
    summary: "Request a file with everything about me (or my child)",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { body: CreateDataExportSchema },
    response: DataExportSchema,
    status: 201,
  })
  @RecentAuth(15)
  async requestExport(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: z.infer<typeof CreateDataExportSchema>,
    @Req() request: FastifyRequest,
  ): Promise<DataExport> {
    const subject = subjectOf(authz, body.personId);
    const row = await this.exports.request(authz.context, subject, localeOfRequest(request));
    const [response] = await this.exportResponses(authz, [row]);
    return response!;
  }

  @Endpoint({
    method: "GET",
    path: "data-exports",
    summary: "My requests for my data (newest first)",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { query: PageQuerySchema },
    response: DataExportsPageSchema,
  })
  async listExports(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof PageQuerySchema>,
  ): Promise<{ items: DataExport[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50;
    const rows = await this.exports.list(authz.context, { after: query.cursor ?? null, limit });
    return {
      items: await this.exportResponses(authz, rows),
      nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
    };
  }

  @Endpoint({
    method: "GET",
    path: "data-exports/:exportId/download",
    summary: "A five-minute download link for my data file",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: DataExportParamsSchema },
    response: DataExportDownloadSchema,
  })
  @RecentAuth(15)
  async download(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof DataExportParamsSchema>,
  ): Promise<{ url: string; expiresAt: string }> {
    const link = await this.exports.download(authz.context, params.exportId);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  @Endpoint({
    method: "GET",
    path: "account/deletion",
    summary: "What deleting my account needs, which children go with it, and a pending deletion",
    tags: ["privacy"],
    access: { authenticated: true },
    response: AccountDeletionPreviewSchema,
  })
  async deletionPreview(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<AccountDeletionPreview> {
    const me = authz.actor.personId;
    const preview = await this.erasure.deletionPreview(authz.context);
    const people = await this.present(
      authz,
      preview.wards.map((w) => w.personId),
    );
    return {
      graceDays: preview.graceDays,
      blockers: preview.blockers,
      wards: preview.wards.flatMap((w) => {
        const person = people.get(w.personId);
        return person ? [{ person, blockers: w.blockers }] : [];
      }),
      pending: preview.pending ? erasureResponse(preview.pending, me) : null,
    };
  }

  @Endpoint({
    method: "POST",
    path: "account/deletion",
    summary: "Delete my account after the grace period (and the chosen children without a login)",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { body: ScheduleAccountDeletionSchema },
    response: ErasureRequestSchema,
    status: 201,
  })
  @RecentAuth(5)
  async scheduleDeletion(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: z.infer<typeof ScheduleAccountDeletionSchema>,
  ): Promise<ErasureRequest> {
    const row = await this.erasure.scheduleDeletion(authz.context, body.eraseWardIds ?? []);
    return erasureResponse(row, authz.actor.personId);
  }

  @Endpoint({
    method: "DELETE",
    path: "account/deletion",
    summary: "Cancel the deletion of my account during the grace period",
    tags: ["privacy"],
    access: { authenticated: true },
    response: EmptySchema,
  })
  async cancelDeletion(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<Record<string, never>> {
    await this.erasure.cancelDeletion(authz.context);
    return {};
  }

  @Endpoint({
    method: "GET",
    path: "wards/:personId/erasure",
    summary: "What erasing my child (without a login) needs, and a pending erasure",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: WardParamsSchema },
    response: WardErasurePreviewSchema,
  })
  async wardPreview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof WardParamsSchema>,
  ): Promise<WardErasurePreview> {
    if (!authz.actor.isFullGuardianOf(params.personId)) throw new ProblemError("not-found");
    const preview = await this.erasure.wardPreview(authz.context, params.personId);
    return {
      graceDays: preview.graceDays,
      hasLogin: preview.hasLogin,
      blockers: preview.blockers,
      pending: preview.pending ? erasureResponse(preview.pending, authz.actor.personId) : null,
    };
  }

  @Endpoint({
    method: "POST",
    path: "wards/:personId/erasure",
    summary: "Erase my child (without a login) after the grace period; other parents may cancel",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: WardParamsSchema },
    response: ErasureRequestSchema,
    status: 201,
  })
  @RecentAuth(5)
  async scheduleWardErasure(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof WardParamsSchema>,
  ): Promise<ErasureRequest> {
    if (!authz.actor.isFullGuardianOf(params.personId)) throw new ProblemError("not-found");
    const row = await this.erasure.scheduleWardErasure(authz.context, params.personId);
    return erasureResponse(row, authz.actor.personId);
  }

  @Endpoint({
    method: "DELETE",
    path: "wards/:personId/erasure",
    summary: "Cancel the scheduled erasure of my child",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: WardParamsSchema },
    response: EmptySchema,
  })
  async cancelWardErasure(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof WardParamsSchema>,
  ): Promise<Record<string, never>> {
    if (!authz.actor.isFullGuardianOf(params.personId)) throw new ProblemError("not-found");
    await this.erasure.cancelWardErasure(authz.context, params.personId);
    return {};
  }
}
