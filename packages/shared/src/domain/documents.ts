// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2, ADR 0049 decisions 1A, 2, 6–8): folders at club or
// group level, files with every version kept, and audiences that decide who
// reads them. A version is downloadable after a clean virus scan, through a
// short-lived link on the storage's own domain (as an attachment). People
// appear only as PersonSummary from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

// --- Audiences (shared with announcements, P2.3) ------------------------------

export const AUDIENCE_ENTRY_KINDS = [
  "club",
  "group",
  "group_roles",
  "club_role",
  "public",
] as const;
export type AudienceEntryKind = (typeof AUDIENCE_ENTRY_KINDS)[number];

/** At most this many entries in one audience, and roles in one group entry. */
export const AUDIENCE_MAX_ENTRIES = 50;
export const AUDIENCE_MAX_GROUP_ROLES = 20;

/**
 * One entry of an audience: the whole club (its members and their
 * guardians, its leaders and role holders), a group (its members and their
 * guardians), some roles of a group (e.g. its leaders), a club role, or
 * everyone (public).
 */
export const AudienceEntryInputSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("club") }).strict(),
    z.object({ kind: z.literal("public") }).strict(),
    z.object({ kind: z.literal("group"), groupId: z.uuid() }).strict(),
    z
      .object({
        kind: z.literal("group_roles"),
        groupId: z.uuid(),
        roleIds: z.array(z.uuid()).min(1).max(AUDIENCE_MAX_GROUP_ROLES),
      })
      .strict(),
    z.object({ kind: z.literal("club_role"), roleId: z.uuid() }).strict(),
  ])
  .openapi("AudienceEntryInput");
export type AudienceEntryInput = z.infer<typeof AudienceEntryInputSchema>;

export const AudienceInputSchema = z
  .array(AudienceEntryInputSchema)
  .min(1)
  .max(AUDIENCE_MAX_ENTRIES)
  .openapi("AudienceInput");
export type AudienceInput = z.infer<typeof AudienceInputSchema>;

/** An audience entry as stored, with the group's name (not personal data). */
export const AudienceEntrySchema = z
  .object({
    kind: z.enum(AUDIENCE_ENTRY_KINDS),
    groupId: z.uuid().nullable(),
    groupName: z.string().nullable(),
    roleIds: z.array(z.uuid()),
  })
  .openapi("AudienceEntry");
export type AudienceEntry = z.infer<typeof AudienceEntrySchema>;

// --- Files --------------------------------------------------------------------

/** File types a club may store (ADR 0049 decision 7): extension → content type. */
export const DOCUMENT_FILE_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
} as const;
export type DocumentFileExtension = keyof typeof DOCUMENT_FILE_TYPES;

/** The largest file (one version). */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** An upload link is valid this long. */
export const DOCUMENT_UPLOAD_SECONDS = 15 * 60;
/** A download link is valid this long. */
export const DOCUMENT_DOWNLOAD_SECONDS = 5 * 60;
/** The default storage limit per club (decision 2026-11-12), unless the plan or installation sets one. */
export const DOCUMENT_DEFAULT_CLUB_LIMIT_BYTES = 100 * 1024 * 1024;
/** Folders nest at most this deep (a top-level folder is depth 1). */
export const DOCUMENT_FOLDER_MAX_DEPTH = 5;
/** At most this many subfolders in one folder. */
export const DOCUMENT_FOLDER_MAX_CHILDREN = 200;

/** The content type for a file name, or null when its type is not allowed. */
export function documentContentType(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return Object.hasOwn(DOCUMENT_FILE_TYPES, extension)
    ? DOCUMENT_FILE_TYPES[extension as DocumentFileExtension]
    : null;
}

export const DOCUMENT_VERSION_STATUSES = [
  /** The upload link is issued; nothing is stored yet. */
  "uploading",
  /** Uploaded; being scanned (not visible yet). */
  "pending",
  "clean",
  /** The scan found malware: deleted, never shown. */
  "infected",
  /** The file was missing or not what it said it was: deleted. */
  "failed",
] as const;
export type DocumentVersionStatus = (typeof DOCUMENT_VERSION_STATUSES)[number];

export const DOCUMENT_KINDS = ["file", "governing"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const FOLDER_PURPOSES = ["files", "notices"] as const;
export type FolderPurpose = (typeof FOLDER_PURPOSES)[number];

const name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    .refine((value) => !/[/\\\u0000-\u001f]/.test(value), { message: "invalid_name" });

export const FolderParamsSchema = z.object({ clubId: z.uuid(), folderId: z.uuid() });
export const GroupFoldersParamsSchema = z.object({ clubId: z.uuid(), groupId: z.uuid() });
export const DocumentParamsSchema = z.object({ clubId: z.uuid(), documentId: z.uuid() });
export const DocumentVersionParamsSchema = DocumentParamsSchema.extend({ versionId: z.uuid() });

export const CreateFolderSchema = z
  .object({
    name: name(120),
    /** None: the group (a group's folder), the club (the club's) or the parent's (a subfolder). */
    audience: AudienceInputSchema.nullish(),
  })
  .strict()
  .openapi("CreateFolder");
export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;

export const UpdateFolderSchema = z
  .object({
    name: name(120).optional(),
    /** Null: the parent's audience again (subfolders only). */
    audience: AudienceInputSchema.nullable().optional(),
  })
  .strict()
  .openapi("UpdateFolder");
export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;

export const DeleteFolderQuerySchema = z.object({
  /** Deleting a folder with files or subfolders needs this (after the client has asked). */
  confirm: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export const FolderSummarySchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    groupId: z.uuid().nullable(),
    parentId: z.uuid().nullable(),
    name: z.string(),
    purpose: z.enum(FOLDER_PURPOSES),
    /** The folder has its own audience (otherwise its parent's applies). */
    ownAudience: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi("FolderSummary");
export type FolderSummary = z.infer<typeof FolderSummarySchema>;

export const FolderPageSchema = z
  .object({
    items: z.array(FolderSummarySchema),
    nextCursor: z.uuid().nullable(),
    /** The caller may create folders here. */
    canManage: z.boolean(),
  })
  .openapi("FolderPage");
export type FolderPage = z.infer<typeof FolderPageSchema>;

export const DocumentVersionSchema = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    fileName: z.string(),
    size: z.number().int(),
    contentType: z.string(),
    status: z.enum(DOCUMENT_VERSION_STATUSES),
    /** SHA-256 of the stored file (hex), once scanned. */
    sha256: z.string().nullable(),
    /** None: hidden (protected identity) or no longer known. */
    uploadedBy: PersonSummarySchema.nullable(),
    uploadedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("DocumentVersion");
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentSummarySchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    folderId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS),
    name: z.string(),
    /** The latest clean version (none until the first scan is clean). */
    current: DocumentVersionSchema.nullable(),
    /**
     * The newest version when it is not the current one (being uploaded,
     * scanned or refused): shown to those who manage the folder.
     */
    latest: DocumentVersionSchema.nullable(),
    ownAudience: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("DocumentSummary");
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const FolderPathItemSchema = z.object({ id: z.uuid(), name: z.string() });

export const FolderContentSchema = z
  .object({
    folder: FolderSummarySchema,
    /** From the top-level folder down to this one. */
    path: z.array(FolderPathItemSchema),
    /** The audience that applies (the folder's own or the nearest parent's). */
    audience: z.array(AudienceEntrySchema),
    subfolders: z.array(FolderSummarySchema),
    documents: z.array(DocumentSummarySchema),
    /** The next page of documents (by name). */
    nextCursor: z.uuid().nullable(),
    canManage: z.boolean(),
  })
  .openapi("FolderContent");
export type FolderContent = z.infer<typeof FolderContentSchema>;

export const DocumentDetailSchema = z
  .object({
    document: DocumentSummarySchema,
    path: z.array(FolderPathItemSchema),
    /** The audience that applies (the document's own or its folder's). */
    audience: z.array(AudienceEntrySchema),
    /** Every version, newest first (those not clean only for managers). */
    versions: z.array(DocumentVersionSchema),
    canManage: z.boolean(),
  })
  .openapi("DocumentDetail");
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

/** Starts an upload: a new file in a folder, or a new version of a file. */
export const StartUploadSchema = z
  .object({
    fileName: name(200),
    size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
    /** A new file's name in the archive (default: the file name). */
    name: name(200).optional(),
  })
  .strict()
  .openapi("StartUpload");
export type StartUploadInput = z.infer<typeof StartUploadSchema>;

export const UploadStartedSchema = z
  .object({
    documentId: z.uuid(),
    versionId: z.uuid(),
    /** PUT the file here with exactly these headers, then confirm. */
    uploadUrl: z.url(),
    headers: z.record(z.string(), z.string()),
    uploadExpiresAt: z.iso.datetime(),
  })
  .openapi("UploadStarted");
export type UploadStarted = z.infer<typeof UploadStartedSchema>;

export const UpdateDocumentSchema = z
  .object({
    name: name(200).optional(),
    /** Another folder of the same club or group. */
    folderId: z.uuid().optional(),
    /** Null: the folder's audience again. */
    audience: AudienceInputSchema.nullable().optional(),
  })
  .strict()
  .openapi("UpdateDocument");
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;

export const DocumentDownloadSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime() })
  .openapi("DocumentDownload");
export type DocumentDownload = z.infer<typeof DocumentDownloadSchema>;

export const DocumentCreatedSchema = z.object({ id: z.uuid() }).openapi("DocumentCreated");
