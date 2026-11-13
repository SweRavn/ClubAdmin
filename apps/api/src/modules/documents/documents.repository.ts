// SPDX-License-Identifier: AGPL-3.0-only
// The file archive's tables (P2.2, migration 0042): audiences and their
// entries, folders, documents and their versions. Every query runs in the
// club's context (tenant RLS) and starts from the club, the folder or the
// document (their indexes); audiences are checked in SQL
// (app.audience_includes), never row by row in code.

import { sql, type Tx } from "@clubadmin/db";
import type {
  AudienceEntryInput,
  AudienceEntryKind,
  DocumentKind,
  DocumentVersionStatus,
  FolderPurpose,
} from "@clubadmin/shared";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

// --- Audiences ----------------------------------------------------------------

export interface AudienceEntryRow {
  audienceId: string;
  kind: AudienceEntryKind;
  groupId: string | null;
  groupName: string | null;
  roleIds: string[];
}

/**
 * Whether every group and role of the entries belongs to the club with the
 * right scope (group roles for a group entry, club roles for a club role).
 */
export async function audienceEntriesValid(
  tx: Tx,
  clubId: string,
  entries: readonly AudienceEntryInput[],
): Promise<boolean> {
  const groupIds = entries.flatMap((e) =>
    e.kind === "group" || e.kind === "group_roles" ? [e.groupId] : [],
  );
  const groupRoleIds = entries.flatMap((e) => (e.kind === "group_roles" ? e.roleIds : []));
  const clubRoleIds = entries.flatMap((e) => (e.kind === "club_role" ? [e.roleId] : []));
  const { rows } = await tx.execute<{
    groups: number;
    group_roles: number;
    club_roles: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM public.groups g
       WHERE g.id = ANY(${uuidArray([...new Set(groupIds)])}::uuid[]) AND g.club_id = ${clubId}::uuid) AS groups,
      (SELECT count(*)::int FROM public.roles r
       WHERE r.id = ANY(${uuidArray([...new Set(groupRoleIds)])}::uuid[]) AND r.club_id = ${clubId}::uuid
         AND r.scope = 'group' AND r.archived_at IS NULL) AS group_roles,
      (SELECT count(*)::int FROM public.roles r
       WHERE r.id = ANY(${uuidArray([...new Set(clubRoleIds)])}::uuid[]) AND r.club_id = ${clubId}::uuid
         AND r.scope = 'club' AND r.archived_at IS NULL) AS club_roles`);
  const row = rows[0]!;
  return (
    row.groups === new Set(groupIds).size &&
    row.group_roles === new Set(groupRoleIds).size &&
    row.club_roles === new Set(clubRoleIds).size
  );
}

async function insertEntries(
  tx: Tx,
  clubId: string,
  audienceId: string,
  entries: readonly AudienceEntryInput[],
): Promise<void> {
  for (const e of entries) {
    await tx.execute(sql`
      INSERT INTO public.audience_entries (club_id, audience_id, kind, group_id, role_ids, role_id)
      VALUES (${clubId}, ${audienceId}, ${e.kind},
        ${e.kind === "group" || e.kind === "group_roles" ? e.groupId : null},
        ${e.kind === "group_roles" ? uuidArray(e.roleIds) : null}::uuid[],
        ${e.kind === "club_role" ? e.roleId : null})`);
  }
}

/** Duplicates are dropped (the same group, role or kind twice). */
function distinctEntries(entries: readonly AudienceEntryInput[]): AudienceEntryInput[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key =
      e.kind === "group"
        ? `group:${e.groupId}`
        : e.kind === "group_roles"
          ? `group_roles:${e.groupId}:${[...e.roleIds].sort().join(",")}`
          : e.kind === "club_role"
            ? `club_role:${e.roleId}`
            : e.kind;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function insertAudience(
  tx: Tx,
  clubId: string,
  entries: readonly AudienceEntryInput[],
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.audiences (club_id) VALUES (${clubId}) RETURNING id`);
  const id = rows[0]!.id;
  await insertEntries(tx, clubId, id, distinctEntries(entries));
  return id;
}

export async function replaceAudience(
  tx: Tx,
  clubId: string,
  audienceId: string,
  entries: readonly AudienceEntryInput[],
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM public.audience_entries WHERE audience_id = ${audienceId}::uuid`,
  );
  await insertEntries(tx, clubId, audienceId, distinctEntries(entries));
  await tx.execute(
    sql`UPDATE public.audiences SET updated_at = now() WHERE id = ${audienceId}::uuid`,
  );
}

export async function audienceEntries(
  tx: Tx,
  audienceIds: readonly string[],
): Promise<Map<string, AudienceEntryRow[]>> {
  const out = new Map<string, AudienceEntryRow[]>();
  if (audienceIds.length === 0) return out;
  const { rows } = await tx.execute<{
    audience_id: string;
    kind: AudienceEntryKind;
    group_id: string | null;
    group_name: string | null;
    role_ids: string[] | null;
    role_id: string | null;
  }>(sql`
    SELECT e.audience_id, e.kind, e.group_id, g.name AS group_name, e.role_ids, e.role_id
    FROM public.audience_entries e
    LEFT JOIN public.groups g ON g.id = e.group_id
    WHERE e.audience_id = ANY(${uuidArray([...new Set(audienceIds)])}::uuid[])
    ORDER BY e.id`);
  for (const r of rows) {
    const list = out.get(r.audience_id) ?? [];
    list.push({
      audienceId: r.audience_id,
      kind: r.kind,
      groupId: r.group_id,
      groupName: r.group_name,
      roleIds: r.role_id ? [r.role_id] : (r.role_ids ?? []),
    });
    out.set(r.audience_id, list);
  }
  return out;
}

// --- Folders ------------------------------------------------------------------

export interface FolderRow {
  id: string;
  clubId: string;
  groupId: string | null;
  parentId: string | null;
  name: string;
  audienceId: string | null;
  purpose: FolderPurpose;
  createdAt: Date;
}

type FolderSql = {
  id: string;
  club_id: string;
  group_id: string | null;
  parent_id: string | null;
  name: string;
  audience_id: string | null;
  purpose: FolderPurpose;
  created_at: string;
};

const FOLDER_COLUMNS = sql`f.id, f.club_id, f.group_id, f.parent_id, f.name, f.audience_id, f.purpose,
  f.created_at::text`;

const toFolder = (r: FolderSql): FolderRow => ({
  id: r.id,
  clubId: r.club_id,
  groupId: r.group_id,
  parentId: r.parent_id,
  name: r.name,
  audienceId: r.audience_id,
  purpose: r.purpose,
  createdAt: new Date(r.created_at),
});

export async function insertFolder(
  tx: Tx,
  input: {
    clubId: string;
    groupId: string | null;
    parentId: string | null;
    name: string;
    audienceId: string | null;
    createdBy: string;
  },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.document_folders (club_id, group_id, parent_id, name, audience_id, created_by_person_id)
    VALUES (${input.clubId}, ${input.groupId}, ${input.parentId}, ${input.name}, ${input.audienceId},
      ${input.createdBy})
    ON CONFLICT DO NOTHING
    RETURNING id`);
  return rows[0]?.id ?? null;
}

/** A folder that is not deleted, with the audience that applies to it. */
export async function findFolder(
  tx: Tx,
  folderId: string,
): Promise<(FolderRow & { effectiveAudienceId: string | null }) | null> {
  const { rows } = await tx.execute<FolderSql & { effective_audience_id: string | null }>(sql`
    SELECT ${FOLDER_COLUMNS}, app.folder_audience(f.id) AS effective_audience_id
    FROM public.document_folders f
    WHERE f.id = ${folderId}::uuid AND f.deleted_at IS NULL`);
  const row = rows[0];
  return row ? { ...toFolder(row), effectiveAudienceId: row.effective_audience_id } : null;
}

export async function lockFolder(tx: Tx, folderId: string): Promise<FolderRow | null> {
  const { rows } = await tx.execute<FolderSql>(sql`
    SELECT ${FOLDER_COLUMNS} FROM public.document_folders f
    WHERE f.id = ${folderId}::uuid AND f.deleted_at IS NULL FOR UPDATE`);
  return rows[0] ? toFolder(rows[0]) : null;
}

/** From the top-level folder down to this one (ID and name). */
export async function folderPath(
  tx: Tx,
  folderId: string,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await tx.execute<{ id: string; name: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT f.id, f.name, f.parent_id, 0 AS depth FROM public.document_folders f
      WHERE f.id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, f.name, f.parent_id, up.depth + 1
      FROM up JOIN public.document_folders f ON f.id = up.parent_id
      WHERE up.depth < 20)
    SELECT id, name FROM up ORDER BY depth DESC`);
  return rows;
}

/**
 * The top-level folders of the club (no group) or of a group, by name,
 * that the person reads (or every one, for those who manage them).
 */
export async function rootFolders(
  tx: Tx,
  input: {
    clubId: string;
    groupId: string | null;
    personId: string;
    all: boolean;
    cursor: string | null;
    limit: number;
  },
): Promise<FolderRow[]> {
  const { rows } = await tx.execute<FolderSql>(sql`
    SELECT ${FOLDER_COLUMNS}
    FROM public.document_folders f
    WHERE f.club_id = ${input.clubId}::uuid
      AND f.group_id IS NOT DISTINCT FROM ${input.groupId}::uuid
      AND f.parent_id IS NULL AND f.deleted_at IS NULL
      AND (${input.cursor}::uuid IS NULL OR (f.name, f.id) > (
        SELECT c.name, c.id FROM public.document_folders c WHERE c.id = ${input.cursor}::uuid))
      AND (${input.all} OR app.audience_includes(f.audience_id, ${input.personId}::uuid))
    ORDER BY f.name, f.id
    LIMIT ${input.limit}`);
  return rows.map(toFolder);
}

/**
 * A folder's subfolders by name that the person reads: their own audience,
 * or (none) the folder's, whose answer the caller passes.
 */
export async function subfolders(
  tx: Tx,
  input: {
    folderId: string;
    personId: string;
    all: boolean;
    inFolderAudience: boolean;
    limit: number;
  },
): Promise<FolderRow[]> {
  const { rows } = await tx.execute<FolderSql>(sql`
    SELECT ${FOLDER_COLUMNS}
    FROM public.document_folders f
    WHERE f.parent_id = ${input.folderId}::uuid AND f.deleted_at IS NULL
      AND (${input.all} OR CASE WHEN f.audience_id IS NULL THEN ${input.inFolderAudience}
        ELSE app.audience_includes(f.audience_id, ${input.personId}::uuid) END)
    ORDER BY f.name, f.id
    LIMIT ${input.limit}`);
  return rows.map(toFolder);
}

export async function childCounts(
  tx: Tx,
  folderId: string,
): Promise<{ folders: number; documents: number }> {
  const { rows } = await tx.execute<{ folders: number; documents: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM public.document_folders f
       WHERE f.parent_id = ${folderId}::uuid AND f.deleted_at IS NULL) AS folders,
      (SELECT count(*)::int FROM public.documents d
       WHERE d.folder_id = ${folderId}::uuid AND d.deleted_at IS NULL) AS documents`);
  return rows[0]!;
}

/** Renames a folder; false when a sibling already has the name. */
export async function renameFolder(tx: Tx, folderId: string, name: string): Promise<boolean> {
  const { rows } = await tx.execute<{ taken: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.document_folders f
      JOIN public.document_folders me ON me.id = ${folderId}::uuid
      WHERE f.id <> me.id AND f.club_id = me.club_id AND f.deleted_at IS NULL
        AND f.group_id IS NOT DISTINCT FROM me.group_id
        AND f.parent_id IS NOT DISTINCT FROM me.parent_id
        AND lower(f.name) = lower(${name})) AS taken`);
  if (rows[0]?.taken) return false;
  await tx.execute(sql`
    UPDATE public.document_folders SET name = ${name} WHERE id = ${folderId}::uuid`);
  return true;
}

export async function setFolderAudience(
  tx: Tx,
  folderId: string,
  audienceId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.document_folders SET audience_id = ${audienceId} WHERE id = ${folderId}::uuid`);
}

/**
 * Deletes a folder with its subfolders and their files (rows kept, marked
 * deleted); returns the deleted files' IDs (their objects are deleted by
 * the worker).
 */
export async function deleteFolderTree(tx: Tx, folderId: string, by: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT f.id, 0 AS depth FROM public.document_folders f WHERE f.id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, tree.depth + 1 FROM tree
      JOIN public.document_folders f ON f.parent_id = tree.id AND f.deleted_at IS NULL
      WHERE tree.depth < 20),
    folders AS (
      UPDATE public.document_folders f SET deleted_at = now(), deleted_by_person_id = ${by}
      WHERE f.id IN (SELECT id FROM tree) RETURNING f.id),
    docs AS (
      UPDATE public.documents d SET deleted_at = now(), deleted_by_person_id = ${by}
      WHERE d.folder_id IN (SELECT id FROM tree) AND d.deleted_at IS NULL RETURNING d.id)
    SELECT id FROM docs`);
  return rows.map((r) => r.id);
}

// --- Documents ----------------------------------------------------------------

export interface VersionRow {
  id: string;
  documentId: string;
  number: number;
  objectKey: string;
  fileName: string;
  size: number;
  contentType: string;
  sha256: string | null;
  status: DocumentVersionStatus;
  uploadedByPersonId: string | null;
  uploadedAt: Date | null;
  createdAt: Date;
}

type VersionSql = {
  id: string;
  document_id: string;
  number: number;
  object_key: string;
  file_name: string;
  size: string;
  content_type: string;
  sha256: string | null;
  status: DocumentVersionStatus;
  uploaded_by_person_id: string | null;
  uploaded_at: string | null;
  created_at: string;
};

const toVersion = (r: VersionSql): VersionRow => ({
  id: r.id,
  documentId: r.document_id,
  number: r.number,
  objectKey: r.object_key,
  fileName: r.file_name,
  size: Number(r.size),
  contentType: r.content_type,
  sha256: r.sha256,
  status: r.status,
  uploadedByPersonId: r.uploaded_by_person_id,
  uploadedAt: r.uploaded_at ? new Date(r.uploaded_at) : null,
  createdAt: new Date(r.created_at),
});

/** A version as JSON (for the lateral subqueries of the document lists). */
const VERSION_JSON = (alias: string) =>
  sql.raw(`jsonb_build_object('id', ${alias}.id, 'document_id', ${alias}.document_id,
    'number', ${alias}.number, 'object_key', ${alias}.object_key, 'file_name', ${alias}.file_name,
    'size', ${alias}.size::text, 'content_type', ${alias}.content_type, 'sha256', ${alias}.sha256,
    'status', ${alias}.status, 'uploaded_by_person_id', ${alias}.uploaded_by_person_id,
    'uploaded_at', ${alias}.uploaded_at::text, 'created_at', ${alias}.created_at::text)`);

export interface DocumentRow {
  id: string;
  clubId: string;
  folderId: string;
  groupId: string | null;
  kind: DocumentKind;
  name: string;
  audienceId: string | null;
  currentVersionId: string | null;
  updatedAt: Date;
  publishedAt: Date | null;
  deleteAfter: string | null;
  current: VersionRow | null;
  /** The newest version when it is not the current one. */
  latest: VersionRow | null;
}

type DocumentSql = {
  id: string;
  club_id: string;
  folder_id: string;
  group_id: string | null;
  kind: DocumentKind;
  name: string;
  audience_id: string | null;
  current_version_id: string | null;
  updated_at: string;
  published_at: string | null;
  delete_after: string | null;
  current: VersionSql | null;
  latest: VersionSql | null;
};

const DOCUMENT_COLUMNS = sql`d.id, d.club_id, d.folder_id, d.group_id, d.kind, d.name, d.audience_id,
  d.current_version_id, greatest(d.updated_at, coalesce(cv.created_at, d.updated_at))::text AS updated_at,
  d.published_at::text, d.delete_after::text,
  CASE WHEN cv.id IS NULL THEN NULL ELSE ${VERSION_JSON("cv")} END AS current,
  (SELECT ${VERSION_JSON("lv")} FROM public.document_versions lv
   WHERE lv.document_id = d.id AND lv.id IS DISTINCT FROM d.current_version_id
     AND lv.number > coalesce(cv.number, 0)
   ORDER BY lv.number DESC LIMIT 1) AS latest`;

const toDocument = (r: DocumentSql): DocumentRow => ({
  id: r.id,
  clubId: r.club_id,
  folderId: r.folder_id,
  groupId: r.group_id,
  kind: r.kind,
  name: r.name,
  audienceId: r.audience_id,
  currentVersionId: r.current_version_id,
  updatedAt: new Date(r.updated_at),
  publishedAt: r.published_at ? new Date(r.published_at) : null,
  deleteAfter: r.delete_after,
  current: r.current ? toVersion(r.current) : null,
  latest: r.latest ? toVersion(r.latest) : null,
});

/**
 * A folder's files by name (keyset on name and ID) that the person reads:
 * their own audience, or (none) the folder's, whose answer the caller
 * passes. Files without a clean version only for those who manage them.
 */
export async function folderDocuments(
  tx: Tx,
  input: {
    folderId: string;
    personId: string;
    all: boolean;
    inFolderAudience: boolean;
    cursor: string | null;
    limit: number;
  },
): Promise<DocumentRow[]> {
  const { rows } = await tx.execute<DocumentSql>(sql`
    SELECT ${DOCUMENT_COLUMNS}
    FROM public.documents d
    LEFT JOIN public.document_versions cv ON cv.id = d.current_version_id
    WHERE d.folder_id = ${input.folderId}::uuid AND d.deleted_at IS NULL
      AND (${input.cursor}::uuid IS NULL OR (d.name, d.id) > (
        SELECT c.name, c.id FROM public.documents c WHERE c.id = ${input.cursor}::uuid))
      AND (${input.all} OR (d.current_version_id IS NOT NULL AND CASE
        WHEN d.audience_id IS NULL THEN ${input.inFolderAudience}
        ELSE app.audience_includes(d.audience_id, ${input.personId}::uuid) END))
    ORDER BY d.name, d.id
    LIMIT ${input.limit}`);
  return rows.map(toDocument);
}

export async function findDocument(
  tx: Tx,
  documentId: string,
): Promise<(DocumentRow & { effectiveAudienceId: string | null }) | null> {
  const { rows } = await tx.execute<DocumentSql & { effective_audience_id: string | null }>(sql`
    SELECT ${DOCUMENT_COLUMNS}, app.document_audience(d.id) AS effective_audience_id
    FROM public.documents d
    LEFT JOIN public.document_versions cv ON cv.id = d.current_version_id
    WHERE d.id = ${documentId}::uuid AND d.deleted_at IS NULL`);
  const row = rows[0];
  return row ? { ...toDocument(row), effectiveAudienceId: row.effective_audience_id } : null;
}

export async function lockDocument(
  tx: Tx,
  documentId: string,
): Promise<{
  id: string;
  folderId: string;
  groupId: string | null;
  audienceId: string | null;
} | null> {
  const { rows } = await tx.execute<{
    id: string;
    folder_id: string;
    group_id: string | null;
    audience_id: string | null;
  }>(sql`
    SELECT id, folder_id, group_id, audience_id FROM public.documents
    WHERE id = ${documentId}::uuid AND deleted_at IS NULL FOR UPDATE`);
  const row = rows[0];
  return row
    ? { id: row.id, folderId: row.folder_id, groupId: row.group_id, audienceId: row.audience_id }
    : null;
}

export async function insertDocument(
  tx: Tx,
  input: {
    id: string;
    clubId: string;
    folderId: string;
    groupId: string | null;
    name: string;
    createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.documents (id, club_id, folder_id, group_id, name, created_by_person_id)
    VALUES (${input.id}, ${input.clubId}, ${input.folderId}, ${input.groupId}, ${input.name},
      ${input.createdBy})`);
}

export async function updateDocument(
  tx: Tx,
  documentId: string,
  changes: {
    name?: string;
    folderId?: string;
    audienceId?: string | null;
    deleteAfter?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.documents SET
      name = coalesce(${changes.name ?? null}, name),
      delete_after = CASE WHEN ${changes.deleteAfter !== undefined} THEN ${changes.deleteAfter ?? null}::date
        ELSE delete_after END,
      deletion_notice_sent_at = CASE WHEN ${changes.deleteAfter !== undefined} THEN NULL
        ELSE deletion_notice_sent_at END,
      folder_id = coalesce(${changes.folderId ?? null}::uuid, folder_id),
      audience_id = CASE WHEN ${changes.audienceId !== undefined} THEN ${changes.audienceId ?? null}::uuid
        ELSE audience_id END
    WHERE id = ${documentId}::uuid`);
}

export async function deleteDocument(tx: Tx, documentId: string, by: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.documents SET deleted_at = now(), deleted_by_person_id = ${by}
    WHERE id = ${documentId}::uuid`);
}

// --- Versions -----------------------------------------------------------------

const VERSION_COLUMNS = sql`v.id, v.document_id, v.number, v.object_key, v.file_name, v.size::text,
  v.content_type, v.sha256, v.status, v.uploaded_by_person_id, v.uploaded_at::text, v.created_at::text`;

/** A document's versions, newest first. */
export async function versions(tx: Tx, documentId: string): Promise<VersionRow[]> {
  const { rows } = await tx.execute<VersionSql>(sql`
    SELECT ${VERSION_COLUMNS} FROM public.document_versions v
    WHERE v.document_id = ${documentId}::uuid ORDER BY v.number DESC LIMIT 200`);
  return rows.map(toVersion);
}

export async function findVersion(tx: Tx, versionId: string): Promise<VersionRow | null> {
  const { rows } = await tx.execute<VersionSql>(sql`
    SELECT ${VERSION_COLUMNS} FROM public.document_versions v WHERE v.id = ${versionId}::uuid`);
  return rows[0] ? toVersion(rows[0]) : null;
}

/** A new version, numbered after the last (the document row is locked by the caller). */
export async function insertVersion(
  tx: Tx,
  input: {
    id: string;
    clubId: string;
    documentId: string;
    groupId: string | null;
    objectKey: string;
    fileName: string;
    size: number;
    contentType: string;
    uploadedBy: string;
    notify: boolean;
  },
): Promise<number> {
  const { rows } = await tx.execute<{ number: number }>(sql`
    INSERT INTO public.document_versions
      (id, club_id, document_id, group_id, number, object_key, file_name, size, content_type,
       uploaded_by_person_id, notify)
    VALUES (${input.id}, ${input.clubId}, ${input.documentId}, ${input.groupId},
      (SELECT coalesce(max(v.number), 0) + 1 FROM public.document_versions v
       WHERE v.document_id = ${input.documentId}::uuid),
      ${input.objectKey}, ${input.fileName}, ${input.size}, ${input.contentType}, ${input.uploadedBy},
      ${input.notify})
    RETURNING number`);
  return rows[0]!.number;
}

/** The upload is done: the version waits for its scan. False if it was not being uploaded. */
export async function markUploaded(tx: Tx, versionId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.document_versions SET status = 'pending', uploaded_at = now()
    WHERE id = ${versionId}::uuid AND status = 'uploading' RETURNING id`);
  return rows.length > 0;
}

/**
 * The bytes the club's stored files use, and the group's (versions not yet
 * refused, their objects not deleted; uploads in progress count).
 */
export async function storageUsage(tx: Tx, clubId: string): Promise<{ club: number }> {
  const { rows } = await tx.execute<{ used: string }>(sql`
    SELECT coalesce(sum(v.size), 0)::text AS used FROM public.document_versions v
    WHERE v.club_id = ${clubId}::uuid AND v.object_deleted_at IS NULL`);
  return { club: Number(rows[0]?.used ?? 0) };
}

/** Takes the club's storage lock for the rest of the transaction (uploads one at a time). */
export async function lockClubStorage(tx: Tx, clubId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('documents:' || ${clubId}, 0))`,
  );
}

/** Whether the audience is narrower than the club (downloads are then audited). */
export async function audienceIsNarrow(tx: Tx, audienceId: string | null): Promise<boolean> {
  if (!audienceId) return true;
  const { rows } = await tx.execute<{ narrow: boolean }>(sql`
    SELECT app.audience_is_narrow(${audienceId}::uuid) AS narrow`);
  return rows[0]?.narrow ?? true;
}

/** Whether the audience includes the person (app.audience_includes). */
export async function audienceIncludes(
  tx: Tx,
  audienceId: string | null,
  personId: string,
): Promise<boolean> {
  if (!audienceId) return false;
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT app.audience_includes(${audienceId}::uuid, ${personId}::uuid) AS ok`);
  return rows[0]?.ok ?? false;
}

// --- Storage limits (P2.2 part B) ------------------------------------------------

/** Bytes stored per group of the club (the usage index). */
export async function groupUsage(tx: Tx, clubId: string): Promise<Map<string, number>> {
  const { rows } = await tx.execute<{ group_id: string; used: string }>(sql`
    SELECT v.group_id, sum(v.size)::text AS used FROM public.document_versions v
    WHERE v.club_id = ${clubId}::uuid AND v.object_deleted_at IS NULL AND v.group_id IS NOT NULL
    GROUP BY v.group_id`);
  return new Map(rows.map((r) => [r.group_id, Number(r.used)]));
}

/** Bytes stored for one group. */
export async function oneGroupUsage(tx: Tx, clubId: string, groupId: string): Promise<number> {
  const { rows } = await tx.execute<{ used: string }>(sql`
    SELECT coalesce(sum(v.size), 0)::text AS used FROM public.document_versions v
    WHERE v.club_id = ${clubId}::uuid AND v.group_id = ${groupId}::uuid
      AND v.object_deleted_at IS NULL`);
  return Number(rows[0]?.used ?? 0);
}

/** The club's own limits: the club's (key null) and per group. */
export async function quotas(tx: Tx, clubId: string): Promise<Map<string | null, number>> {
  const { rows } = await tx.execute<{ group_id: string | null; limit_bytes: string }>(sql`
    SELECT group_id, limit_bytes::text FROM public.storage_quotas WHERE club_id = ${clubId}::uuid`);
  return new Map(rows.map((r) => [r.group_id, Number(r.limit_bytes)]));
}

export async function setQuota(
  tx: Tx,
  clubId: string,
  groupId: string | null,
  limitBytes: number | null,
): Promise<void> {
  if (limitBytes === null) {
    await tx.execute(sql`
      DELETE FROM public.storage_quotas
      WHERE club_id = ${clubId}::uuid AND group_id IS NOT DISTINCT FROM ${groupId}::uuid`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO public.storage_quotas (club_id, group_id, limit_bytes)
    VALUES (${clubId}, ${groupId}, ${limitBytes})
    ON CONFLICT (club_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET limit_bytes = EXCLUDED.limit_bytes`);
}

export async function groupNames(
  tx: Tx,
  clubId: string,
  groupIds: readonly string[],
): Promise<Map<string, string>> {
  if (groupIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM public.groups
    WHERE club_id = ${clubId}::uuid AND id = ANY(${uuidArray([...new Set(groupIds)])}::uuid[])`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// --- Notices (P2.2 part B) -------------------------------------------------------

export type Notice = { activityId: string } | { eventId: string };

const noticeWhere = (notice: Notice) =>
  "activityId" in notice
    ? sql`n.activity_id = ${notice.activityId}::uuid`
    : sql`n.event_id = ${notice.eventId}::uuid`;

/** The documents attached to a notice, with when they were attached (oldest first). */
export async function noticeAttachments(
  tx: Tx,
  notice: Notice,
): Promise<{ document: DocumentRow; attachedAt: Date }[]> {
  const { rows } = await tx.execute<DocumentSql & { attached_at: string }>(sql`
    SELECT ${DOCUMENT_COLUMNS}, n.created_at::text AS attached_at
    FROM public.notice_attachments n
    JOIN public.documents d ON d.id = n.document_id AND d.deleted_at IS NULL
    LEFT JOIN public.document_versions cv ON cv.id = d.current_version_id
    WHERE ${noticeWhere(notice)}
    ORDER BY n.id`);
  return rows.map((r) => ({ document: toDocument(r), attachedAt: new Date(r.attached_at) }));
}

/** Of these documents, the ones the person reads (app.document_readable). */
export async function readableDocuments(
  tx: Tx,
  documentIds: readonly string[],
  personId: string,
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM unnest(${uuidArray([...new Set(documentIds)])}::uuid[]) AS ids(id)
    WHERE app.document_readable(id, ${personId}::uuid)`);
  return new Set(rows.map((r) => r.id));
}

/** Of these documents, the club's existing ones (not deleted). */
export async function existingDocuments(
  tx: Tx,
  clubId: string,
  documentIds: readonly string[],
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.documents
    WHERE club_id = ${clubId}::uuid AND deleted_at IS NULL
      AND id = ANY(${uuidArray([...new Set(documentIds)])}::uuid[])`);
  return new Set(rows.map((r) => r.id));
}

/** Replaces a notice's documents; returns the added and removed document IDs. */
export async function setNoticeAttachments(
  tx: Tx,
  clubId: string,
  notice: Notice,
  documentIds: readonly string[],
  by: string,
): Promise<{ added: string[]; removed: string[] }> {
  const ids = uuidArray([...new Set(documentIds)]);
  const { rows: removed } = await tx.execute<{ document_id: string }>(sql`
    DELETE FROM public.notice_attachments n
    WHERE ${noticeWhere(notice)} AND NOT (n.document_id = ANY(${ids}::uuid[]))
    RETURNING n.document_id`);
  const activityId = "activityId" in notice ? notice.activityId : null;
  const eventId = "eventId" in notice ? notice.eventId : null;
  const { rows: added } = await tx.execute<{ document_id: string }>(sql`
    INSERT INTO public.notice_attachments (club_id, activity_id, event_id, document_id, attached_by_person_id)
    SELECT ${clubId}, ${activityId}::uuid, ${eventId}::uuid, id, ${by}
    FROM unnest(${ids}::uuid[]) AS ids(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.notice_attachments n
                      WHERE ${noticeWhere(notice)} AND n.document_id = ids.id)
    RETURNING document_id`);
  return { added: added.map((r) => r.document_id), removed: removed.map((r) => r.document_id) };
}

/**
 * To whom a notice shows its documents: an activity's call-up (count) or
 * its groups; an event's groups or the whole club. Group names only.
 */
export async function noticeReaders(
  tx: Tx,
  notice: Notice,
): Promise<{ club: boolean; groups: { id: string; name: string }[]; calledUp: number | null }> {
  if ("activityId" in notice) {
    const { rows } = await tx.execute<{
      invitees_only: boolean;
      called_up: number;
      groups: { id: string; name: string }[] | null;
    }>(sql`
      SELECT a.invitees_only,
        (SELECT count(*)::int FROM public.activity_invitees i WHERE i.activity_id = a.id) AS called_up,
        (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
         FROM public.activity_groups ag JOIN public.groups g ON g.id = ag.group_id
         WHERE ag.activity_id = a.id) AS groups
      FROM public.activities a WHERE a.id = ${notice.activityId}::uuid`);
    const row = rows[0];
    return {
      club: false,
      groups: row?.groups ?? [],
      calledUp: row?.invitees_only ? row.called_up : null,
    };
  }
  const { rows } = await tx.execute<{
    audience: string;
    groups: { id: string; name: string }[] | null;
  }>(sql`
    SELECT e.audience,
      (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
       FROM public.event_groups eg JOIN public.groups g ON g.id = eg.group_id
       WHERE eg.event_id = e.id) AS groups
    FROM public.events e WHERE e.id = ${notice.eventId}::uuid`);
  const row = rows[0];
  return { club: row?.audience === "club", groups: row?.groups ?? [], calledUp: null };
}

/** The notices folder of the club (groupId null) or a group, if it exists. */
export async function noticesFolder(
  tx: Tx,
  clubId: string,
  groupId: string | null,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.document_folders
    WHERE club_id = ${clubId}::uuid AND group_id IS NOT DISTINCT FROM ${groupId}::uuid
      AND parent_id IS NULL AND purpose = 'notices' AND deleted_at IS NULL
    ORDER BY id LIMIT 1`);
  return rows[0]?.id ?? null;
}

export async function insertNoticesFolder(
  tx: Tx,
  input: { clubId: string; groupId: string | null; name: string; audienceId: string; by: string },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.document_folders
      (club_id, group_id, name, audience_id, purpose, created_by_person_id)
    VALUES (${input.clubId}, ${input.groupId}, ${input.name}, ${input.audienceId}, 'notices', ${input.by})
    ON CONFLICT DO NOTHING RETURNING id`);
  return rows[0]?.id ?? null;
}

/** The first group of an activity or event (by name), or null (none: the club's). */
export async function noticeGroup(tx: Tx, notice: Notice): Promise<string | null> {
  const { rows } = await tx.execute<{ group_id: string }>(
    "activityId" in notice
      ? sql`SELECT ag.group_id FROM public.activity_groups ag JOIN public.groups g ON g.id = ag.group_id
            WHERE ag.activity_id = ${notice.activityId}::uuid ORDER BY g.name, g.id LIMIT 1`
      : sql`SELECT eg.group_id FROM public.event_groups eg JOIN public.groups g ON g.id = eg.group_id
            WHERE eg.event_id = ${notice.eventId}::uuid ORDER BY g.name, g.id LIMIT 1`,
  );
  return rows[0]?.group_id ?? null;
}

export async function clubLocale(tx: Tx, clubId: string): Promise<string> {
  const { rows } = await tx.execute<{ default_locale: string }>(sql`
    SELECT default_locale FROM public.clubs WHERE id = ${clubId}::uuid`);
  return rows[0]?.default_locale ?? "sv-SE";
}

// --- "Mina dokument" (P2.2 part B) ----------------------------------------------

export interface MyDocumentRow {
  document: DocumentRow;
  clubName: string;
  groupName: string | null;
  isNew: boolean;
}

/** The caller's newest readable files (app.my_documents; outside a club). */
export async function myDocuments(
  tx: Tx,
  cursor: string | null,
  limit: number,
): Promise<MyDocumentRow[]> {
  const { rows } = await tx.execute<{
    document_id: string;
    club_id: string;
    club_name: string;
    group_id: string | null;
    group_name: string | null;
    folder_id: string;
    name: string;
    kind: DocumentKind;
    own_audience: boolean;
    published_at: string;
    updated_at: string;
    delete_after: string | null;
    current_version: VersionSql;
    is_new: boolean;
  }>(sql`
    SELECT document_id, club_id, club_name, group_id, group_name, folder_id, name, kind,
      own_audience, published_at::text, updated_at::text, delete_after::text, current_version, is_new
    FROM app.my_documents(${cursor}::uuid, ${limit})`);
  return rows.map((r) => {
    const current = toVersion(r.current_version);
    return {
      document: {
        id: r.document_id,
        clubId: r.club_id,
        folderId: r.folder_id,
        groupId: r.group_id,
        kind: r.kind,
        name: r.name,
        audienceId: r.own_audience ? "own" : null,
        currentVersionId: current.id,
        updatedAt: new Date(r.updated_at),
        publishedAt: new Date(r.published_at),
        deleteAfter: r.delete_after,
        current,
        latest: null,
      },
      clubName: r.club_name,
      groupName: r.group_name,
      isNew: r.is_new,
    };
  });
}

export async function markSeen(tx: Tx, clubId: string, groupId: string | null): Promise<void> {
  await tx.execute(sql`SELECT app.mark_documents_seen(${clubId}::uuid, ${groupId}::uuid)`);
}

// --- Public documents (P2.2 part B) ---------------------------------------------

export async function clubBySlug(tx: Tx, slug: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.clubs WHERE slug = ${slug}`);
  return rows[0]?.id ?? null;
}

/** The club's public files (current version), by name. */
export async function publicDocuments(tx: Tx, clubId: string): Promise<DocumentRow[]> {
  const { rows } = await tx.execute<DocumentSql>(sql`
    SELECT ${DOCUMENT_COLUMNS}
    FROM app.public_documents(${clubId}::uuid) p
    JOIN public.documents d ON d.id = p.document_id
    LEFT JOIN public.document_versions cv ON cv.id = d.current_version_id
    ORDER BY d.name, d.id
    LIMIT 500`);
  return rows.map(toDocument);
}
