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
  type DocumentsSeenInput,
  DocumentsSeenSchema,
  DocumentVersionParamsSchema,
  type FolderContent,
  FolderContentSchema,
  type FolderPage,
  FolderPageSchema,
  FolderParamsSchema,
  type FolderSummary,
  GroupFoldersParamsSchema,
  type MyDocumentPage,
  MyDocumentPageSchema,
  type MyDocumentsQuery,
  MyDocumentsQuerySchema,
  type PageQuery,
  PageQuerySchema,
  PublicClubParamsSchema,
  type PublicDocumentList,
  PublicDocumentListSchema,
  PublicDocumentParamsSchema,
  type StartUploadInput,
  StartUploadSchema,
  type Storage,
  StorageSchema,
  type UpdateDocumentInput,
  UpdateDocumentSchema,
  type UpdateFolderInput,
  UpdateFolderSchema,
  type UpdateStorageInput,
  UpdateStorageSchema,
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
  DocumentsService,
  type FolderRow,
  type VersionRow,
} from "./documents.service.ts";
import { iso, loadUploaders, toDocument, toVersion, type Uploaders } from "./documents.views.ts";

const TAGS = ["documents"];
/** Public documents: per address, generous for a club's visitors. */
const PUBLIC_LIMIT = { max: 120, timeWindowMs: 60_000 };
const FolderCreatedSchema = z.object({ id: z.uuid() }).openapi("FolderCreated");
const FolderContentQuerySchema = PageQuerySchema;

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
  private uploaders(
    authz: RequestAuthorization,
    clubId: string,
    versions: readonly (VersionRow | null)[],
  ): Promise<Uploaders> {
    return loadUploaders(this.people, this.presenter, authz, clubId, versions);
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

  // --- "Mina dokument" (P2.2 part B) ----------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/documents",
    summary: "Mina dokument: the newest files of the caller's groups and clubs, new ones marked",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: MyDocumentsQuerySchema },
    response: MyDocumentPageSchema,
  })
  async myDocuments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: MyDocumentsQuery,
  ): Promise<MyDocumentPage> {
    const page = await this.documents.myDocuments(authz.context, query);
    // Uploaders are shown per club (each club's view of its members).
    const byClub = new Map<string, VersionRow[]>();
    for (const r of page.rows) {
      const list = byClub.get(r.document.clubId) ?? [];
      list.push(r.document.current!);
      byClub.set(r.document.clubId, list);
    }
    const uploaders: Uploaders = new Map();
    for (const [clubId, versions] of byClub) {
      for (const [id, p] of await this.uploaders(authz, clubId, versions)) uploaders.set(id, p);
    }
    return {
      items: page.rows.map((r) => ({
        document: toDocument(r.document, uploaders),
        clubName: r.clubName,
        groupId: r.document.groupId,
        groupName: r.groupName,
        isNew: r.isNew,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/documents/seen",
    summary: "The caller looked at the club's documents (or a group's): nothing is new there now",
    tags: TAGS,
    access: { permission: "club.documents.read", resource: "club" },
    request: { params: ClubParamsSchema, body: DocumentsSeenSchema },
    response: z.null(),
    status: 204,
  })
  @RequiresEntitlement("documents")
  async seen(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: DocumentsSeenInput,
  ): Promise<null> {
    await this.documents.markSeen(tenantContext(authz, params.clubId), body.groupId ?? null);
    return null;
  }

  // --- Storage (P2.2 part B) ------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/storage",
    summary: "The club's file storage: used, the limits, and per group",
    tags: TAGS,
    access: { permission: "club.documents.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: StorageSchema,
  })
  @RequiresEntitlement("documents")
  storage(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<Storage> {
    return this.documents.storageOf(tenantContext(authz, params.clubId));
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/storage",
    summary: "Set the club's own storage limit and limits per group",
    tags: TAGS,
    access: { permission: "club.documents.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: UpdateStorageSchema },
    response: StorageSchema,
  })
  @RequiresEntitlement("documents")
  async updateStorage(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: UpdateStorageInput,
  ): Promise<Storage> {
    const context = tenantContext(authz, params.clubId);
    await this.documents.updateStorage(context, body);
    return this.documents.storageOf(context);
  }

  // --- Public documents (P2.2 part B) ---------------------------------------------

  @Endpoint({
    method: "GET",
    path: "public/clubs/:slug/documents",
    summary: "A club's public documents (for its public pages)",
    tags: TAGS,
    access: { public: true },
    request: { params: PublicClubParamsSchema },
    response: PublicDocumentListSchema,
    rateLimit: PUBLIC_LIMIT,
  })
  async publicDocuments(@Param() params: { slug: string }): Promise<PublicDocumentList> {
    const rows = await this.documents.publicDocuments(params.slug);
    return {
      items: rows.flatMap((d) =>
        d.current
          ? [
              {
                id: d.id,
                name: d.name,
                fileName: d.current.fileName,
                size: d.current.size,
                contentType: d.current.contentType,
                publishedAt: d.publishedAt ? iso(d.publishedAt) : null,
              },
            ]
          : [],
      ),
    };
  }

  @Endpoint({
    method: "GET",
    path: "public/clubs/:slug/documents/:documentId/download",
    summary: "A short-lived download link of a club's public document",
    tags: TAGS,
    access: { public: true },
    request: { params: PublicDocumentParamsSchema },
    response: DocumentDownloadSchema,
    rateLimit: PUBLIC_LIMIT,
  })
  async publicDownload(
    @Param() params: { slug: string; documentId: string },
  ): Promise<DocumentDownload> {
    const link = await this.documents.publicDownload(params.slug, params.documentId);
    return { url: link.url, expiresAt: iso(link.expiresAt) };
  }
}
