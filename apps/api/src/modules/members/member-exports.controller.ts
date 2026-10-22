// SPDX-License-Identifier: AGPL-3.0-only
// Exports of the member register (P1.2): club managers and registrars, with a
// second factor and a recent login, queue a CSV of the current filter; the
// worker writes it to object storage; only the requester downloads it, for
// 24 hours. Exports keep working for read-only and suspended clubs (ADR 0031).

import {
  ClubParamsSchema,
  type CreateMemberExportInput,
  CreateMemberExportSchema,
  type MemberExport as MemberExportResponse,
  type MemberExportDownload,
  MemberExportDownloadSchema,
  type MemberExportList,
  MemberExportListSchema,
  MemberExportParamsSchema,
  MemberExportSchema,
  type PageQuery,
  PageQuerySchema,
  type PersonSummary,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import { type MemberExport, MembersService } from "./members.service.ts";

function toResponse(
  row: MemberExport,
  requestedBy: PersonSummary | null,
  me: string | null,
): MemberExportResponse {
  const expired = row.status === "ready" && row.expiresAt !== null && row.expiresAt <= new Date();
  return {
    id: row.id,
    status: expired ? "expired" : row.status,
    requestedBy,
    mine: row.requestedByPersonId === me,
    columns: row.columns,
    includeProtected: row.includeProtected,
    rowCount: row.rowCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    errorCode: row.errorCode,
  };
}

@Controller("clubs")
export class MemberExportsController {
  private readonly members: MembersService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(members: MembersService, people: PeopleService, presenter: PersonPresenter) {
    this.members = members;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/member-exports",
    summary: "Export the register (filter and columns) as CSV; every club manager is told",
    tags: ["members"],
    access: { permission: "club.members.export", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateMemberExportSchema },
    response: MemberExportSchema,
    status: 202,
    clubAccess: "export",
  })
  @RecentAuth(15)
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateMemberExportInput,
  ): Promise<MemberExportResponse> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const row = await this.members.requestExport(context, body);
    const [me] = await this.people.summaries(context, [row.requestedByPersonId]);
    const requestedBy = me ? await this.presenter.presentOne(authz, clubId, me) : null;
    return toResponse(row, requestedBy, context.personId ?? null);
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/member-exports",
    summary: "Recent exports of the register (who, when, columns, row count), newest first",
    tags: ["members"],
    access: { permission: "club.members.export", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: MemberExportListSchema,
    clubAccess: "export",
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<MemberExportList> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const page = await this.members.listExports(context, query);
    const requesters = [...new Set(page.items.map((e) => e.requestedByPersonId))];
    const rows = await this.people.summaries(context, requesters);
    const shown = new Map(
      (await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]),
    );
    return {
      items: page.items.map((e) =>
        toResponse(e, shown.get(e.requestedByPersonId) ?? null, context.personId ?? null),
      ),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/member-exports/:exportId/download",
    summary: "A download link valid for 5 minutes (the requester only, while the file exists)",
    tags: ["members"],
    access: { permission: "club.members.export", resource: "club" },
    request: { params: MemberExportParamsSchema },
    response: MemberExportDownloadSchema,
    clubAccess: "export",
  })
  async download(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("exportId") exportId: string,
  ): Promise<MemberExportDownload> {
    const { clubId } = resourceOf(authz, "club");
    const link = await this.members.download(tenantContext(authz, clubId), exportId);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }
}
