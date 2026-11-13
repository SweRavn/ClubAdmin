// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2, ADR 0049): folders of the club and its groups,
// files with versions, uploads (pre-signed PUT, then a virus scan) and
// downloads (short-lived links on the storage's domain). Reading follows the
// audiences (folder.read, document.read); managing the club's archive needs
// club.documents.manage, a group's also group.documents.manage or owning
// the group. Uploaders go through the PersonPresenter.

import {
  type AudienceEntry,
  ClubParamsSchema,
  type CreateFolderInput,
  CreateFolderSchema,
  DeleteFolderQuerySchema,
  type DocumentDetail,
  DocumentDetailSchema,
  type DocumentDownload,
  DocumentDownloadSchema,
  DocumentParamsSchema,
  type DocumentSummary,
  type DocumentVersion,
  DocumentVersionParamsSchema,
  type FolderContent,
  FolderContentSchema,
  type FolderPage,
  FolderPageSchema,
  FolderParamsSchema,
  type FolderSummary,
  GroupFoldersParamsSchema,
  type PageQuery,
  PageQuerySchema,
  type PersonSummary,
  type StartUploadInput,
  StartUploadSchema,
  type UpdateDocumentInput,
  UpdateDocumentSchema,
  type UpdateFolderInput,
  UpdateFolderSchema,
  type UploadStarted,
  UploadStartedSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

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
import {
  type AudienceEntryRow,
  type DocumentRow,
  DocumentsService,
  type FolderRow,
  type VersionRow,
} from "./documents.service.ts";

const TAGS = ["documents"];
const FolderCreatedSchema = z.object({ id: z.uuid() }).openapi("FolderCreated");
const FolderContentQuerySchema = PageQuerySchema;

const iso = (d: Date) => d.toISOString();

const toFolder = (f: FolderRow): FolderSummary => ({
  id: f.id,
  clubId: f.clubId,
  groupId: f.groupId,
  parentId: f.parentId,
  name: f.name,
  purpose: f.purpose,
  ownAudience: f.audienceId !== null,
  createdAt: iso(f.createdAt),
});

const toAudience = (entries: readonly AudienceEntryRow[]): AudienceEntry[] =>
  entries.map((e) => ({
    kind: e.kind,
    groupId: e.groupId,
    groupName: e.groupName,
    roleIds: e.roleIds,
  }));

type Uploaders = Map<string, PersonSummary>;

function toVersion(v: VersionRow, uploaders: Uploaders): DocumentVersion {
  return {
    id: v.id,
    number: v.number,
    fileName: v.fileName,
    size: v.size,
    contentType: v.contentType,
    status: v.status,
    sha256: v.sha256,
    uploadedBy: (v.uploadedByPersonId && uploaders.get(v.uploadedByPersonId)) || null,
    uploadedAt: v.uploadedAt ? iso(v.uploadedAt) : null,
    createdAt: iso(v.createdAt),
  };
}

function toDocument(d: DocumentRow, uploaders: Uploaders): DocumentSummary {
  return {
    id: d.id,
    clubId: d.clubId,
    folderId: d.folderId,
    kind: d.kind,
    name: d.name,
    current: d.current ? toVersion(d.current, uploaders) : null,
    latest: d.latest ? toVersion(d.latest, uploaders) : null,
    ownAudience: d.audienceId !== null,
    updatedAt: iso(d.updatedAt),
  };
}

@Controller()
export class DocumentsController {
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

  /** The uploaders the caller may see (hidden people are left out). */
  private async uploaders(
    authz: RequestAuthorization,
    clubId: string,
    versions: readonly (VersionRow | null)[],
  ): Promise<Uploaders> {
    const ids = [
      ...new Set(versions.flatMap((v) => (v?.uploadedByPersonId ? [v.uploadedByPersonId] : []))),
    ];
    if (ids.length === 0) return new Map();
    const context = tenantContext(authz, clubId);
    const rows = await this.people.summaries(context, ids);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  // --- Folders ----------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/folders",
    summary: "The club's top-level folders the caller reads, by name",
    tags: TAGS,
    access: { permission: "club.documents.read", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: FolderPageSchema,
  })
  @RequiresEntitlement("documents")
  async clubFolders(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: PageQuery,
  ): Promise<FolderPage> {
    const manage = permits(authz.actor, "club.documents.manage", {
      kind: "club",
      clubId: params.clubId,
    });
    const page = await this.documents.rootFolders(tenantContext(authz, params.clubId), {
      groupId: null,
      manage,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.rows.map(toFolder), nextCursor: page.nextCursor, canManage: manage };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/folders",
    summary: "Create a top-level folder of the club (default audience: the whole club)",
    tags: TAGS,
    access: { permission: "club.documents.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateFolderSchema },
    response: FolderCreatedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async createClubFolder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateFolderInput,
  ): Promise<{ id: string }> {
    const id = await this.documents.createFolder(
      tenantContext(authz, params.clubId),
      { groupId: null },
      body,
    );
    return { id };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/folders",
    summary: "A group's top-level folders the caller reads, by name",
    tags: TAGS,
    access: { permission: "group.documents.read", resource: "group" },
    request: { params: GroupFoldersParamsSchema, query: PageQuerySchema },
    response: FolderPageSchema,
  })
  @RequiresEntitlement("documents")
  async groupFolders(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: PageQuery,
  ): Promise<FolderPage> {
    const group = resourceOf(authz, "group");
    const manage = permits(authz.actor, "group.documents.manage", group);
    const page = await this.documents.rootFolders(tenantContext(authz, params.clubId), {
      groupId: params.groupId,
      manage,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.rows.map(toFolder), nextCursor: page.nextCursor, canManage: manage };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/folders",
    summary: "Create a top-level folder of a group (default audience: the group)",
    tags: TAGS,
    access: { permission: "group.documents.manage", resource: "group" },
    request: { params: GroupFoldersParamsSchema, body: CreateFolderSchema },
    response: FolderCreatedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async createGroupFolder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: CreateFolderInput,
  ): Promise<{ id: string }> {
    const id = await this.documents.createFolder(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      body,
    );
    return { id };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/folders/:folderId",
    summary: "A folder: its path, audience, subfolders and files (by name)",
    tags: TAGS,
    access: { permission: "folder.read", resource: "folder" },
    request: { params: FolderParamsSchema, query: FolderContentQuerySchema },
    response: FolderContentSchema,
  })
  @RequiresEntitlement("documents")
  async folder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; folderId: string },
    @Query() query: PageQuery,
  ): Promise<FolderContent> {
    const manage = permits(authz.actor, "folder.manage", resourceOf(authz, "folder"));
    const content = await this.documents.folder(
      tenantContext(authz, params.clubId),
      params.folderId,
      { manage, cursor: query.cursor, limit: query.limit },
    );
    const uploaders = await this.uploaders(
      authz,
      params.clubId,
      content.documents.flatMap((d) => [d.current, d.latest]),
    );
    return {
      folder: toFolder(content.folder),
      path: content.path,
      audience: toAudience(content.audience),
      subfolders: content.subfolders.map(toFolder),
      documents: content.documents.map((d) => toDocument(d, uploaders)),
      nextCursor: content.nextCursor,
      canManage: manage,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/folders/:folderId/folders",
    summary: "Create a subfolder (default audience: the folder's)",
    tags: TAGS,
    access: { permission: "folder.manage", resource: "folder" },
    request: { params: FolderParamsSchema, body: CreateFolderSchema },
    response: FolderCreatedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async createSubfolder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; folderId: string },
    @Body() body: CreateFolderInput,
  ): Promise<{ id: string }> {
    const id = await this.documents.createFolder(
      tenantContext(authz, params.clubId),
      { parentId: params.folderId },
      body,
    );
    return { id };
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/folders/:folderId",
    summary: "Rename a folder or set its audience (null: the parent's)",
    tags: TAGS,
    access: { permission: "folder.manage", resource: "folder" },
    request: { params: FolderParamsSchema, body: UpdateFolderSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async updateFolder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; folderId: string },
    @Body() body: UpdateFolderInput,
  ): Promise<null> {
    await this.documents.updateFolder(tenantContext(authz, params.clubId), params.folderId, body);
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/folders/:folderId",
    summary: "Delete a folder with its subfolders and files (with content: ?confirm=true)",
    tags: TAGS,
    access: { permission: "folder.manage", resource: "folder" },
    request: { params: FolderParamsSchema, query: DeleteFolderQuerySchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async deleteFolder(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; folderId: string },
    @Query() query: z.output<typeof DeleteFolderQuerySchema>,
  ): Promise<null> {
    await this.documents.deleteFolder(
      tenantContext(authz, params.clubId),
      params.folderId,
      query.confirm,
    );
    return null;
  }

  // --- Files ------------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/folders/:folderId/uploads",
    summary: "Start uploading a new file: PUT it to the link, then confirm",
    tags: TAGS,
    access: { permission: "folder.manage", resource: "folder" },
    request: { params: FolderParamsSchema, body: StartUploadSchema },
    response: UploadStartedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async startUpload(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; folderId: string },
    @Body() body: StartUploadInput,
  ): Promise<UploadStarted> {
    const started = await this.documents.startUpload(
      tenantContext(authz, params.clubId),
      params.folderId,
      body,
    );
    return { ...started, uploadExpiresAt: iso(started.uploadExpiresAt) };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/documents/:documentId",
    summary: "A file with its versions and the audience that applies",
    tags: TAGS,
    access: { permission: "document.read", resource: "document" },
    request: { params: DocumentParamsSchema },
    response: DocumentDetailSchema,
  })
  @RequiresEntitlement("documents")
  async document(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<DocumentDetail> {
    const manage = permits(authz.actor, "document.manage", resourceOf(authz, "document"));
    const detail = await this.documents.document(
      tenantContext(authz, params.clubId),
      params.documentId,
      manage,
    );
    const uploaders = await this.uploaders(authz, params.clubId, detail.versions);
    return {
      document: toDocument(detail.document, uploaders),
      path: detail.path,
      audience: toAudience(detail.audience),
      versions: detail.versions.map((v) => toVersion(v, uploaders)),
      canManage: manage,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/documents/:documentId",
    summary: "Rename a file, move it to another folder of the club or group, or set its audience",
    tags: TAGS,
    access: { permission: "document.manage", resource: "document" },
    request: { params: DocumentParamsSchema, body: UpdateDocumentSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async updateDocument(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
    @Body() body: UpdateDocumentInput,
  ): Promise<null> {
    if (body.folderId !== undefined) {
      // The caller must manage the target folder too (its policy).
      const target = await this.authorization.folderResourceOf(
        authz.actor,
        params.clubId,
        body.folderId,
      );
      if (!permits(authz.actor, "folder.manage", target)) throw new ProblemError("forbidden");
    }
    await this.documents.updateDocument(
      tenantContext(authz, params.clubId),
      params.documentId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/documents/:documentId",
    summary: "Delete a file with all its versions",
    tags: TAGS,
    access: { permission: "document.manage", resource: "document" },
    request: { params: DocumentParamsSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async deleteDocument(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<null> {
    await this.documents.deleteDocument(tenantContext(authz, params.clubId), params.documentId);
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/documents/:documentId/versions",
    summary: "Start uploading a new version of a file (the earlier ones stay)",
    tags: TAGS,
    access: { permission: "document.manage", resource: "document" },
    request: { params: DocumentParamsSchema, body: StartUploadSchema },
    response: UploadStartedSchema,
    status: 201,
  })
  @RequiresEntitlement("documents")
  async startVersion(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
    @Body() body: StartUploadInput,
  ): Promise<UploadStarted> {
    const started = await this.documents.startVersion(
      tenantContext(authz, params.clubId),
      params.documentId,
      body,
    );
    return { ...started, uploadExpiresAt: iso(started.uploadExpiresAt) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/documents/:documentId/versions/:versionId/uploaded",
    summary: "The upload is done: the file is scanned before it is visible",
    tags: TAGS,
    access: { permission: "document.manage", resource: "document" },
    request: { params: DocumentVersionParamsSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async uploaded(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string; versionId: string },
  ): Promise<null> {
    await this.documents.uploaded(
      tenantContext(authz, params.clubId),
      params.documentId,
      params.versionId,
    );
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/documents/:documentId/download",
    summary: "A short-lived download link of the file's current version",
    tags: TAGS,
    access: { permission: "document.read", resource: "document" },
    request: { params: DocumentParamsSchema },
    response: DocumentDownloadSchema,
  })
  @RequiresEntitlement("documents")
  async download(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string },
  ): Promise<DocumentDownload> {
    const link = await this.documents.download(
      tenantContext(authz, params.clubId),
      params.documentId,
      null,
    );
    return { url: link.url, expiresAt: iso(link.expiresAt) };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/documents/:documentId/versions/:versionId/download",
    summary: "A short-lived download link of one version of a file",
    tags: TAGS,
    access: { permission: "document.read", resource: "document" },
    request: { params: DocumentVersionParamsSchema },
    response: DocumentDownloadSchema,
  })
  @RequiresEntitlement("documents")
  async downloadVersion(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; documentId: string; versionId: string },
  ): Promise<DocumentDownload> {
    const link = await this.documents.download(
      tenantContext(authz, params.clubId),
      params.documentId,
      params.versionId,
    );
    return { url: link.url, expiresAt: iso(link.expiresAt) };
  }
}
