// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2, ADR 0049 decisions 1A, 2, 6–8).
//
// - Folders at club or group level; a subfolder inherits its parent's
//   audience unless it has its own. Deleting a folder with content needs a
//   confirmation and deletes its subfolders and files (rows kept, the
//   worker deletes the stored objects).
// - Files keep every version. An upload is a short-lived pre-signed PUT of
//   exactly the declared size to the club's prefix; when the client says it
//   is done, the worker scans it (ClamAV) and only a clean version becomes
//   the file's current one.
// - The club's storage (all versions) stays within its limit: the plan's
//   `storage_gb` or the installation's default (100 MB).
// - Downloads are short-lived links on the storage's own domain, served as
//   attachments; downloads of files with an audience narrower than the
//   club are audited.
// Who may do what is the policies' (folder.*, document.*); the controller
// passes whether the caller manages the folder.

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import {
  type AudienceInput,
  type CreateFolderInput,
  DOCUMENT_DOWNLOAD_SECONDS,
  DOCUMENT_FOLDER_MAX_CHILDREN,
  DOCUMENT_FOLDER_MAX_DEPTH,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_UPLOAD_SECONDS,
  documentContentType,
  type StartUploadInput,
  type UpdateDocumentInput,
  type UpdateFolderInput,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import * as repo from "./documents.repository.ts";

export type {
  AudienceEntryRow,
  DocumentRow,
  FolderRow,
  VersionRow,
} from "./documents.repository.ts";

/** At most this many file IDs per `documents.deleted` event. */
const DELETED_BATCH = 1000;

export interface FolderContent {
  folder: repo.FolderRow;
  path: { id: string; name: string }[];
  audience: repo.AudienceEntryRow[];
  subfolders: repo.FolderRow[];
  documents: repo.DocumentRow[];
  nextCursor: string | null;
}

export interface DocumentDetail {
  document: repo.DocumentRow;
  path: { id: string; name: string }[];
  audience: repo.AudienceEntryRow[];
  versions: repo.VersionRow[];
}

export interface UploadStarted {
  documentId: string;
  versionId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  uploadExpiresAt: Date;
}

export class DocumentsService {
  private readonly db: Database;
  private readonly storage: ObjectStorage | null;
  private readonly clubLimitBytes: (clubId: string) => Promise<number>;

  constructor(
    db: Database,
    deps: {
      storage: ObjectStorage | null;
      /** The club's storage limit in bytes (the plan's or the installation's). */
      clubLimitBytes: (clubId: string) => Promise<number>;
    },
  ) {
    this.db = db;
    this.storage = deps.storage;
    this.clubLimitBytes = deps.clubLimitBytes;
  }

  // --- Folders ----------------------------------------------------------------

  /** The top-level folders of the club (groupId null) or a group, by name. */
  rootFolders(
    context: TenantContext,
    input: { groupId: string | null; manage: boolean; cursor?: string | undefined; limit: number },
  ): Promise<{ rows: repo.FolderRow[]; nextCursor: string | null }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.rootFolders(tx, {
        clubId: context.clubId,
        groupId: input.groupId,
        personId,
        all: input.manage,
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const items = rows.slice(0, input.limit);
      return { rows: items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
    });
  }

  /**
   * Creates a top-level folder of the club or a group (default audience:
   * the whole club, or the group), or a subfolder (default: the parent's).
   */
  async createFolder(
    context: TenantContext,
    where: { groupId: string | null } | { parentId: string },
    input: CreateFolderInput,
  ): Promise<string> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      let groupId: string | null;
      let parentId: string | null = null;
      if ("parentId" in where) {
        const parent = await repo.lockFolder(tx, where.parentId);
        if (!parent) throw new DomainError("not_found");
        if ((await repo.folderPath(tx, parent.id)).length >= DOCUMENT_FOLDER_MAX_DEPTH) {
          throw new DomainError("folder_too_deep");
        }
        if ((await repo.childCounts(tx, parent.id)).folders >= DOCUMENT_FOLDER_MAX_CHILDREN) {
          throw new DomainError("folder_too_many");
        }
        groupId = parent.groupId;
        parentId = parent.id;
      } else {
        groupId = where.groupId;
      }
      const entries: AudienceInput | null =
        input.audience ??
        (parentId ? null : groupId ? [{ kind: "group", groupId }] : [{ kind: "club" }]);
      const audienceId = entries ? await this.newAudience(tx, context.clubId, entries) : null;
      const id = await repo.insertFolder(tx, {
        clubId: context.clubId,
        groupId,
        parentId,
        name: input.name,
        audienceId,
        createdBy: personId,
      });
      if (!id) throw new DomainError("folder_name_taken");
      await audit.record(tx, {
        action: "document.folder.created",
        resourceType: "document_folder",
        resourceId: id,
      });
      return id;
    });
  }

  /** A folder: its path, the audience that applies, subfolders and a page of files. */
  folder(
    context: TenantContext,
    folderId: string,
    input: { manage: boolean; cursor?: string | undefined; limit: number },
  ): Promise<FolderContent> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const folder = await repo.findFolder(tx, folderId);
      if (!folder) throw new DomainError("not_found");
      const inFolderAudience =
        input.manage || (await repo.audienceIncludes(tx, folder.effectiveAudienceId, personId));
      const path = await repo.folderPath(tx, folderId);
      const subfolders = await repo.subfolders(tx, {
        folderId,
        personId,
        all: input.manage,
        inFolderAudience,
        limit: DOCUMENT_FOLDER_MAX_CHILDREN,
      });
      const documents = await repo.folderDocuments(tx, {
        folderId,
        personId,
        all: input.manage,
        inFolderAudience,
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const audiences = await repo.audienceEntries(
        tx,
        folder.effectiveAudienceId ? [folder.effectiveAudienceId] : [],
      );
      const items = documents.slice(0, input.limit);
      return {
        folder,
        path,
        audience: audiences.get(folder.effectiveAudienceId ?? "") ?? [],
        subfolders,
        documents: items,
        nextCursor: documents.length > input.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** Renames a folder and sets its audience (null: the parent's again, subfolders only). */
  async updateFolder(
    context: TenantContext,
    folderId: string,
    input: UpdateFolderInput,
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const folder = await repo.lockFolder(tx, folderId);
      if (!folder) throw new DomainError("not_found");
      const changed: string[] = [];
      if (input.name !== undefined && input.name !== folder.name) {
        if (!(await repo.renameFolder(tx, folderId, input.name))) {
          throw new DomainError("folder_name_taken");
        }
        changed.push("name");
      }
      if (input.audience !== undefined) {
        if (input.audience === null) {
          if (!folder.parentId) throw new DomainError("audience_required");
          if (folder.audienceId) await repo.setFolderAudience(tx, folderId, null);
        } else if (folder.audienceId) {
          await this.replaceAudience(tx, context.clubId, folder.audienceId, input.audience);
        } else {
          const audienceId = await this.newAudience(tx, context.clubId, input.audience);
          await repo.setFolderAudience(tx, folderId, audienceId);
        }
        changed.push("audience_id");
      }
      if (changed.length === 0) return;
      await audit.record(tx, {
        action: "document.folder.updated",
        resourceType: "document_folder",
        resourceId: folderId,
        changedFields: changed,
      });
    });
  }

  /**
   * Deletes a folder, its subfolders and their files. A folder with content
   * needs `confirm` (the client asked the person first).
   */
  async deleteFolder(context: TenantContext, folderId: string, confirm: boolean): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const folder = await repo.lockFolder(tx, folderId);
      if (!folder) throw new DomainError("not_found");
      const counts = await repo.childCounts(tx, folderId);
      if (!confirm && counts.folders + counts.documents > 0) {
        throw new DomainError("folder_not_empty");
      }
      const documentIds = await repo.deleteFolderTree(tx, folderId, personId);
      await audit.record(tx, {
        action: "document.folder.deleted",
        resourceType: "document_folder",
        resourceId: folderId,
      });
      await this.publishDeleted(tx, context.clubId, documentIds);
    });
  }

  // --- Uploads ----------------------------------------------------------------

  /** A new file in a folder: its first version's upload link. */
  async startUpload(
    context: TenantContext,
    folderId: string,
    input: StartUploadInput,
  ): Promise<UploadStarted> {
    const personId = actorPersonId(context);
    const { storage, contentType } = this.checkUpload(input);
    // Before the transaction: the limit may be read in a transaction of its own.
    const limit = await this.clubLimitBytes(context.clubId);
    return this.db.withTenant(context, async (tx) => {
      const folder = await repo.lockFolder(tx, folderId);
      if (!folder) throw new DomainError("not_found");
      await this.reserve(tx, context.clubId, input.size, limit);
      const documentId = uuidv7();
      await repo.insertDocument(tx, {
        id: documentId,
        clubId: context.clubId,
        folderId,
        groupId: folder.groupId,
        name: input.name ?? input.fileName,
        createdBy: personId,
      });
      await audit.record(tx, {
        action: "document.created",
        resourceType: "document",
        resourceId: documentId,
      });
      return this.newVersion(tx, storage, context.clubId, {
        documentId,
        groupId: folder.groupId,
        fileName: input.fileName,
        size: input.size,
        contentType,
        personId,
      });
    });
  }

  /** A new version of a file: its upload link (the earlier versions stay). */
  async startVersion(
    context: TenantContext,
    documentId: string,
    input: StartUploadInput,
  ): Promise<UploadStarted> {
    const personId = actorPersonId(context);
    const { storage, contentType } = this.checkUpload(input);
    const limit = await this.clubLimitBytes(context.clubId);
    return this.db.withTenant(context, async (tx) => {
      const document = await repo.lockDocument(tx, documentId);
      if (!document) throw new DomainError("not_found");
      await this.reserve(tx, context.clubId, input.size, limit);
      return this.newVersion(tx, storage, context.clubId, {
        documentId,
        groupId: document.groupId,
        fileName: input.fileName,
        size: input.size,
        contentType,
        personId,
      });
    });
  }

  /** The client uploaded the version: the worker scans it before it is visible. */
  async uploaded(context: TenantContext, documentId: string, versionId: string): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const version = await repo.findVersion(tx, versionId);
      if (!version || version.documentId !== documentId) throw new DomainError("not_found");
      if (version.status !== "uploading") {
        if (version.status === "pending" || version.status === "clean") return;
        throw new DomainError("document_version_not_uploading");
      }
      await repo.markUploaded(tx, versionId);
      await audit.record(tx, {
        action: "document.version.added",
        resourceType: "document",
        resourceId: documentId,
      });
      await outbox.publish(tx, "document.version.uploaded", {
        clubId: context.clubId,
        versionId,
      });
    });
  }

  private checkUpload(input: StartUploadInput): { storage: ObjectStorage; contentType: string } {
    if (!this.storage) throw new DomainError("documents_storage_unavailable");
    const contentType = documentContentType(input.fileName);
    if (!contentType) throw new DomainError("document_type_not_allowed");
    if (input.size > DOCUMENT_MAX_BYTES) throw new DomainError("document_too_large");
    return { storage: this.storage, contentType };
  }

  /** Refuses an upload that would take the club over its limit (one upload at a time per club). */
  private async reserve(tx: Tx, clubId: string, size: number, limit: number): Promise<void> {
    await repo.lockClubStorage(tx, clubId);
    const usage = await repo.storageUsage(tx, clubId);
    if (usage.club + size > limit) throw new DomainError("storage_limit_exceeded");
  }

  private async newVersion(
    tx: Tx,
    storage: ObjectStorage,
    clubId: string,
    input: {
      documentId: string;
      groupId: string | null;
      fileName: string;
      size: number;
      contentType: string;
      personId: string;
    },
  ): Promise<UploadStarted> {
    const versionId = uuidv7();
    const objectKey = `documents/${clubId}/${input.documentId}/${versionId}`;
    await repo.insertVersion(tx, {
      id: versionId,
      clubId,
      documentId: input.documentId,
      groupId: input.groupId,
      objectKey,
      fileName: input.fileName,
      size: input.size,
      contentType: input.contentType,
      uploadedBy: input.personId,
    });
    return {
      documentId: input.documentId,
      versionId,
      uploadUrl: storage.presignUpload(objectKey, {
        expiresSeconds: DOCUMENT_UPLOAD_SECONDS,
        size: input.size,
        contentType: input.contentType,
      }),
      headers: { "content-type": input.contentType, "content-length": String(input.size) },
      uploadExpiresAt: new Date(Date.now() + DOCUMENT_UPLOAD_SECONDS * 1000),
    };
  }

  // --- Documents --------------------------------------------------------------

  /** A file with its versions (those not clean only for those who manage it). */
  document(context: TenantContext, documentId: string, manage: boolean): Promise<DocumentDetail> {
    return this.db.withTenant(context, async (tx) => {
      const document = await repo.findDocument(tx, documentId);
      if (!document) throw new DomainError("not_found");
      if (!manage && !document.current) throw new DomainError("not_found");
      const path = await repo.folderPath(tx, document.folderId);
      const versions = await repo.versions(tx, documentId);
      const audiences = await repo.audienceEntries(
        tx,
        document.effectiveAudienceId ? [document.effectiveAudienceId] : [],
      );
      return {
        document: manage ? document : { ...document, latest: null },
        path,
        audience: audiences.get(document.effectiveAudienceId ?? "") ?? [],
        versions: manage ? versions : versions.filter((v) => v.status === "clean"),
      };
    });
  }

  /**
   * Renames a file, moves it to another folder of the same club or group
   * (the controller checks that the caller manages the target) and sets its
   * audience (null: the folder's again).
   */
  async updateDocument(
    context: TenantContext,
    documentId: string,
    input: UpdateDocumentInput,
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const document = await repo.lockDocument(tx, documentId);
      if (!document) throw new DomainError("not_found");
      const changed: string[] = [];
      const changes: { name?: string; folderId?: string; audienceId?: string | null } = {};
      if (input.name !== undefined) {
        changes.name = input.name;
        changed.push("name");
      }
      if (input.folderId !== undefined && input.folderId !== document.folderId) {
        const target = await repo.findFolder(tx, input.folderId);
        if (!target) throw new DomainError("not_found");
        if (target.groupId !== document.groupId) throw new DomainError("document_move_scope");
        changes.folderId = target.id;
        changed.push("folder_id");
      }
      if (input.audience !== undefined) {
        if (input.audience === null) {
          changes.audienceId = null;
        } else if (document.audienceId) {
          await this.replaceAudience(tx, context.clubId, document.audienceId, input.audience);
        } else {
          changes.audienceId = await this.newAudience(tx, context.clubId, input.audience);
        }
        changed.push("audience_id");
      }
      if (changed.length === 0) return;
      await repo.updateDocument(tx, documentId, changes);
      await audit.record(tx, {
        action: "document.updated",
        resourceType: "document",
        resourceId: documentId,
        changedFields: changed,
      });
    });
  }

  async deleteDocument(context: TenantContext, documentId: string): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const document = await repo.lockDocument(tx, documentId);
      if (!document) throw new DomainError("not_found");
      await repo.deleteDocument(tx, documentId, personId);
      await audit.record(tx, {
        action: "document.deleted",
        resourceType: "document",
        resourceId: documentId,
      });
      await this.publishDeleted(tx, context.clubId, [documentId]);
    });
  }

  /**
   * A short-lived download link of the current version (or a given one),
   * after a clean scan; audited when the file's audience is narrower than
   * the club.
   */
  async download(
    context: TenantContext,
    documentId: string,
    versionId: string | null,
  ): Promise<{ url: string; expiresAt: Date }> {
    const storage = this.storage;
    if (!storage) throw new DomainError("documents_storage_unavailable");
    return this.db.withTenant(context, async (tx) => {
      const document = await repo.findDocument(tx, documentId);
      if (!document) throw new DomainError("not_found");
      if (!versionId && !document.current) throw new DomainError("document_not_ready");
      const version = versionId ? await repo.findVersion(tx, versionId) : document.current;
      if (!version || version.documentId !== documentId) throw new DomainError("not_found");
      if (version.status !== "clean") throw new DomainError("document_not_ready");
      if (await repo.audienceIsNarrow(tx, document.effectiveAudienceId)) {
        await audit.record(tx, {
          action: "document.downloaded",
          resourceType: "document",
          resourceId: documentId,
        });
      }
      return {
        url: storage.presignDownload(version.objectKey, {
          expiresSeconds: DOCUMENT_DOWNLOAD_SECONDS,
          filename: version.fileName,
        }),
        expiresAt: new Date(Date.now() + DOCUMENT_DOWNLOAD_SECONDS * 1000),
      };
    });
  }

  // --- Audiences --------------------------------------------------------------

  private async newAudience(tx: Tx, clubId: string, entries: AudienceInput): Promise<string> {
    if (!(await repo.audienceEntriesValid(tx, clubId, entries))) {
      throw new DomainError("audience_invalid");
    }
    return repo.insertAudience(tx, clubId, entries);
  }

  private async replaceAudience(
    tx: Tx,
    clubId: string,
    audienceId: string,
    entries: AudienceInput,
  ): Promise<void> {
    if (!(await repo.audienceEntriesValid(tx, clubId, entries))) {
      throw new DomainError("audience_invalid");
    }
    await repo.replaceAudience(tx, clubId, audienceId, entries);
  }

  private async publishDeleted(tx: Tx, clubId: string, documentIds: string[]): Promise<void> {
    for (let i = 0; i < documentIds.length; i += DELETED_BATCH) {
      await outbox.publish(tx, "documents.deleted", {
        clubId,
        documentIds: documentIds.slice(i, i + DELETED_BATCH),
      });
    }
  }
}
