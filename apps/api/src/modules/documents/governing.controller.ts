// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents (P2.4, ADR 0049 decision 1B; ADR 0037): series of the
// club or its groups, drafts in Markdown, adoption (with MFA) that locks the
// version and records the settings its text marks, supersession and
// archiving. Reading follows the series' audience (document.read); editors
// and those who recorded an adoption go through the PersonPresenter.

import {
  type AdoptGoverningDocumentInput,
  AdoptGoverningDocumentSchema,
  ClubParamsSchema,
  type CreateDocumentSeriesInput,
  CreateDocumentSeriesSchema,
  type CreateGoverningDocumentInput,
  CreateGoverningDocumentSchema,
  type DocumentSeriesPage,
  DocumentSeriesPageSchema,
  type DocumentSeriesQuery,
  DocumentSeriesQuerySchema,
  type GoverningDocument,
  GoverningDocumentCreatedSchema,
  GoverningDocumentParamsSchema,
  GoverningDocumentSchema,
  type GoverningVersion,
  GoverningVersionParamsSchema,
  type GoverningVersionText,
  GoverningVersionTextSchema,
  type PersonSummary,
  type UpdateGoverningDocumentInput,
  UpdateGoverningDocumentSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import { RequireMfa } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import { GoverningService, type TextVersionRow } from "./governing.service.ts";

const TAGS = ["documents"];
const SeriesCreatedSchema = z.object({ id: z.uuid() }).openapi("DocumentSeriesCreated");
const DraftSavedSchema = z
  .object({ versionId: z.uuid().nullable() })
  .openapi("GoverningDraftSaved");

const iso = (d: Date) => d.toISOString();

@Controller()
export class GoverningController {
  private readonly governing: GoverningService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(governing: GoverningService, people: PeopleService, presenter: PersonPresenter) {
    this.governing = governing;
    this.people = people;
    this.presenter = presenter;
  }

  private canManage(authz: RequestAuthorization, clubId: string): boolean {
    return permits(authz.actor, "club.governing_documents.manage", { kind: "club", clubId });
  }

  /** The editors and recorders of these versions the caller may see. */
  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    versions: readonly TextVersionRow[],
  ): Promise<Map<string, PersonSummary>> {
    const ids = [
      ...new Set(
        versions.flatMap((v) =>
          [v.editedByPersonId, v.adoptedByPersonId].filter((id): id is string => id !== null),
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), ids);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  // --- Series -----------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/document-series",
    summary: "The series of governing documents of the club (or a group) the caller reads",
    tags: TAGS,
    access: { permission: "club.documents.read", resource: "club" },
    request: { params: ClubParamsSchema, query: DocumentSeriesQuerySchema },
    response: DocumentSeriesPageSchema,
  })
  @RequiresEntitlement("documents")
  async series(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: DocumentSeriesQuery,
  ): Promise<DocumentSeriesPage> {
    const manage = this.canManage(authz, params.clubId);
    const page = await this.governing.series(tenantContext(authz, params.clubId), {
      groupId: query.groupId ?? null,
      manage,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.rows.map((f) => ({
        id: f.id,
        clubId: f.clubId,
        groupId: f.groupId,
        name: f.name,
        seriesKind: f.seriesKind ?? "other",
        createdAt: iso(f.createdAt),
      })),
      nextCursor: page.nextCursor,
      canManage: manage,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/document-series",
    summary: "Create a series of governing documents (default audience: the club, or the group)",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateDocumentSeriesSchema },
    response: SeriesCreatedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async createSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateDocumentSeriesInput,
  ): Promise<{ id: string }> {
    const id = await this.governing.createSeries(tenantContext(authz, params.clubId), body);
    return { id };
  }

  // --- Documents --------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/governing-documents",
    summary: "Draft a governing document in a series",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateGoverningDocumentSchema },
    response: GoverningDocumentCreatedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateGoverningDocumentInput,
  ): Promise<{ id: string; versionId: string }> {
    return this.governing.create(tenantContext(authz, params.clubId), body);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/governing-documents/:documentId",
    summary: "A governing document: the text in force, the draft (managers) and its versions",
    tags: TAGS,
    access: { permission: "document.read", resource: "document" },
    request: { params: GoverningDocumentParamsSchema },
    response: GoverningDocumentSchema,
  })
  @RequiresEntitlement("documents")
  async document(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<GoverningDocument> {
    const manage = this.canManage(authz, params.clubId);
    const view = await this.governing.document(
      tenantContext(authz, params.clubId),
      params.documentId,
      manage,
    );
    const persons = await this.persons(authz, params.clubId, [
      ...view.versions,
      ...(view.current ? [view.current] : []),
      ...(view.draft ? [view.draft] : []),
    ]);
    const withText = (v: TextVersionRow): GoverningVersionText => ({
      ...toVersion(v, persons),
      body: v.body ?? "",
    });
    return {
      id: view.document.id,
      clubId: view.document.clubId,
      groupId: view.document.groupId,
      series: {
        id: view.series.id,
        name: view.series.name,
        seriesKind: view.series.seriesKind ?? "other",
      },
      name: view.document.name,
      status: view.document.governingStatus ?? "draft",
      current: view.current ? withText(view.current) : null,
      draft: view.draft ? withText(view.draft) : null,
      versions: view.versions.map((v) => toVersion(v, persons)),
      supersededBy: view.supersededBy,
      supersedes: view.supersedes,
      audience: view.audience.map((e) => ({
        kind: e.kind,
        groupId: e.groupId,
        groupName: e.groupName,
        roleIds: e.roleIds,
      })),
      canManage: manage,
      canAdopt: permits(authz.actor, "club.governing_documents.adopt", {
        kind: "club",
        clubId: params.clubId,
      }),
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/governing-documents/:documentId/versions/:versionId",
    summary: "One version's text (readers: adopted versions), for comparing versions",
    tags: TAGS,
    access: { permission: "document.read", resource: "document" },
    request: { params: GoverningVersionParamsSchema },
    response: GoverningVersionTextSchema,
  })
  @RequiresEntitlement("documents")
  async version(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string; versionId: string },
  ): Promise<GoverningVersionText> {
    const version = await this.governing.version(
      tenantContext(authz, params.clubId),
      params.documentId,
      params.versionId,
      this.canManage(authz, params.clubId),
    );
    const persons = await this.persons(authz, params.clubId, [version]);
    return { ...toVersion(version, persons), body: version.body ?? "" };
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/governing-documents/:documentId",
    summary: "Rename a governing document and save its draft (a new draft after an adoption)",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: GoverningDocumentParamsSchema, body: UpdateGoverningDocumentSchema },
    response: DraftSavedSchema,
  })
  @RequiresEntitlement("documents")
  update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
    @Body() body: UpdateGoverningDocumentInput,
  ): Promise<{ versionId: string | null }> {
    return this.governing.update(tenantContext(authz, params.clubId), params.documentId, body);
  }

  @RequireMfa()
  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/governing-documents/:documentId/adopt",
    summary: "Record the draft as adopted (locks it; writes the settings it marks); needs MFA",
    tags: TAGS,
    access: { permission: "club.governing_documents.adopt", resource: "club" },
    request: { params: GoverningDocumentParamsSchema, body: AdoptGoverningDocumentSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async adopt(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
    @Body() body: AdoptGoverningDocumentInput,
  ): Promise<null> {
    await this.governing.adopt(tenantContext(authz, params.clubId), params.documentId, body);
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/governing-documents/:documentId/archive",
    summary: "Archive an adopted governing document (kept, no longer in force)",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: GoverningDocumentParamsSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async archive(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<null> {
    await this.governing.archive(tenantContext(authz, params.clubId), params.documentId);
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/governing-documents/:documentId",
    summary: "Delete a draft that was never adopted",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: GoverningDocumentParamsSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<null> {
    await this.governing.delete(tenantContext(authz, params.clubId), params.documentId);
    return null;
  }
}

function toVersion(v: TextVersionRow, persons: Map<string, PersonSummary>): GoverningVersion {
  return {
    id: v.id,
    number: v.number,
    sha256: v.sha256,
    editedBy: (v.editedByPersonId && persons.get(v.editedByPersonId)) || null,
    createdAt: iso(v.createdAt),
    adoption:
      v.adoptedOn && v.effectiveFrom && v.adoptedAt
        ? {
            adoptedOn: v.adoptedOn,
            effectiveFrom: v.effectiveFrom,
            meeting: v.adoptedActivityId
              ? { kind: "activity", id: v.adoptedActivityId }
              : v.adoptedEventId
                ? { kind: "event", id: v.adoptedEventId }
                : null,
            recordedBy: (v.adoptedByPersonId && persons.get(v.adoptedByPersonId)) || null,
            recordedAt: iso(v.adoptedAt),
          }
        : null,
  };
}
