// SPDX-License-Identifier: AGPL-3.0-only
// Member imports (P1.3b): registrars and club managers with a second factor
// upload a CSV file, map its columns, preview every row and confirm with a
// recent login; jobs parse and import (ADR 0033). Every club manager is
// emailed when an import finishes.

import type { TenantContext } from "@clubadmin/db";
import {
  ClubParamsSchema,
  type CreateMemberImportInput,
  CreateMemberImportSchema,
  type MemberImport,
  type MemberImportCreated,
  MemberImportCreatedSchema,
  type MemberImportList,
  MemberImportListSchema,
  MemberImportOptionsSchema,
  MemberImportParamsSchema,
  type MemberImportRow,
  type MemberImportRowPage,
  MemberImportRowPageSchema,
  MemberImportRowParamsSchema,
  MemberImportRowSchema,
  type MemberImportRowsQuery,
  MemberImportRowsQuerySchema,
  MemberImportSchema,
  type PageQuery,
  PageQuerySchema,
  type UpdateMemberImportMappingInput,
  UpdateMemberImportMappingSchema,
  type UpdateMemberImportRowInput,
  UpdateMemberImportRowSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  MemberImportPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  type MemberImport as ImportRecord,
  MemberImportsService,
  type MemberImportStagingRow,
} from "./member-imports.service.ts";

@Controller("clubs")
export class MemberImportsController {
  private readonly imports: MemberImportsService;
  private readonly people: PeopleService;
  private readonly presenter: MemberImportPresenter;

  constructor(
    imports: MemberImportsService,
    people: PeopleService,
    presenter: MemberImportPresenter,
  ) {
    this.imports = imports;
    this.people = people;
    this.presenter = presenter;
  }

  private async present(
    authz: RequestAuthorization,
    clubId: string,
    context: TenantContext,
    rows: readonly ImportRecord[],
  ): Promise<MemberImport[]> {
    const creators = [...new Set(rows.map((r) => r.createdByPersonId))];
    const people = await this.people.summaries(context, creators);
    return this.presenter.imports(authz, clubId, rows, people, context.personId ?? null);
  }

  private async presentOne(
    authz: RequestAuthorization,
    clubId: string,
    context: TenantContext,
    row: ImportRecord,
  ): Promise<MemberImport> {
    const [result] = await this.present(authz, clubId, context, [row]);
    if (!result) throw new DomainError("not_found");
    return result;
  }

  private async presentRows(
    authz: RequestAuthorization,
    clubId: string,
    context: TenantContext,
    imp: ImportRecord,
    rows: readonly MemberImportStagingRow[],
  ): Promise<MemberImportRow[]> {
    const ids = [
      ...new Set(rows.flatMap((r) => [r.personId, r.matchPersonId].filter((id) => id !== null))),
    ];
    const people = await this.people.summaries(context, ids);
    return this.presenter.rows(
      authz,
      clubId,
      rows,
      people,
      MemberImportOptionsSchema.parse(imp.options).sendInvitations,
    );
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/member-imports",
    summary: "Start an import: a pre-signed upload link for the CSV file (PUT, 15 minutes)",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateMemberImportSchema },
    response: MemberImportCreatedSchema,
    status: 201,
  })
  async start(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateMemberImportInput,
  ): Promise<MemberImportCreated> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const started = await this.imports.start(context, body);
    return {
      import: await this.presentOne(authz, clubId, context, started.import),
      uploadUrl: started.uploadUrl,
      uploadExpiresAt: started.uploadExpiresAt.toISOString(),
    };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/member-imports/:importId/uploaded",
    summary: "The file is uploaded: it is parsed and validated in the background",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema },
    response: MemberImportSchema,
    status: 202,
  })
  async uploaded(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
  ): Promise<MemberImport> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    return this.presentOne(authz, clubId, context, await this.imports.uploaded(context, importId));
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/member-imports",
    summary: "The club's imports (who, when, counts), newest first",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: MemberImportListSchema,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<MemberImportList> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const page = await this.imports.list(context, query);
    return {
      items: await this.present(authz, clubId, context, page.items),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/member-imports/:importId",
    summary: "An import: status, detected columns, suggested mapping, counts",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema },
    response: MemberImportSchema,
  })
  async get(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
  ): Promise<MemberImport> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    return this.presentOne(authz, clubId, context, await this.imports.get(context, importId));
  }

  @Endpoint({
    method: "PUT",
    path: ":clubId/member-imports/:importId/mapping",
    summary: "Column mapping and options; the rows are validated again",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema, body: UpdateMemberImportMappingSchema },
    response: MemberImportSchema,
    status: 202,
  })
  async mapping(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
    @Body() body: UpdateMemberImportMappingInput,
  ): Promise<MemberImport> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    return this.presentOne(
      authz,
      clubId,
      context,
      await this.imports.updateMapping(context, importId, body),
    );
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/member-imports/:importId/rows",
    summary: "Preview rows with their status and issues, by row number",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema, query: MemberImportRowsQuerySchema },
    response: MemberImportRowPageSchema,
    bulkRead: true,
  })
  async rows(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
    @Query() query: MemberImportRowsQuery,
  ): Promise<MemberImportRowPage> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const imp = await this.imports.get(context, importId);
    const page = await this.imports.rows(context, importId, query);
    return {
      items: await this.presentRows(authz, clubId, context, imp, page.items),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: ":clubId/member-imports/:importId/rows/:rowNumber",
    summary: "Skip or un-skip a row; a matched row is the same or a different person",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportRowParamsSchema, body: UpdateMemberImportRowSchema },
    response: MemberImportRowSchema,
  })
  async updateRow(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
    @Param("rowNumber") rowNumber: string,
    @Body() body: UpdateMemberImportRowInput,
  ): Promise<MemberImportRow> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const row = await this.imports.updateRow(context, importId, Number(rowNumber), body);
    const imp = await this.imports.get(context, importId);
    const [result] = await this.presentRows(authz, clubId, context, imp, [row]);
    return result!;
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/member-imports/:importId/confirm",
    summary: "Confirm the import (recent login): the members are added in the background",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema },
    response: MemberImportSchema,
    status: 202,
  })
  @RecentAuth(15)
  async confirm(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
  ): Promise<MemberImport> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    return this.presentOne(authz, clubId, context, await this.imports.confirm(context, importId));
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/member-imports/:importId/cancel",
    summary: "Cancel an import before confirmation; the uploaded file is deleted",
    tags: ["members"],
    access: { permission: "club.members.import", resource: "club" },
    request: { params: MemberImportParamsSchema },
    response: MemberImportSchema,
  })
  async cancel(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("importId") importId: string,
  ): Promise<MemberImport> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    return this.presentOne(authz, clubId, context, await this.imports.cancel(context, importId));
  }
}
