// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents' rows (P2.4, ADR 0049 decision 1B): series (folders of
// the purpose `series`), governing documents and their Markdown versions with
// the adoption of each. The file archive's own rows are in
// documents.repository.ts.

import { sql, type Tx } from "@clubadmin/db";
import type { GoverningStatus } from "@clubadmin/shared";

import type { FolderRow } from "./documents.repository.ts";

type SeriesSql = {
  id: string;
  club_id: string;
  group_id: string | null;
  parent_id: string | null;
  name: string;
  audience_id: string | null;
  series_kind: NonNullable<FolderRow["seriesKind"]>;
  created_at: string;
};

const toSeries = (r: SeriesSql): FolderRow => ({
  id: r.id,
  clubId: r.club_id,
  groupId: r.group_id,
  parentId: r.parent_id,
  name: r.name,
  audienceId: r.audience_id,
  purpose: "series",
  seriesKind: r.series_kind,
  createdAt: new Date(r.created_at),
});

/**
 * The series of the club (no group) or of a group, by name, that the person
 * reads (or every one, for those who manage governing documents). By the
 * index of top-level folders.
 */
export async function seriesPage(
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
  const { rows } = await tx.execute<SeriesSql>(sql`
    SELECT f.id, f.club_id, f.group_id, f.parent_id, f.name, f.audience_id, f.series_kind,
      f.created_at::text
    FROM public.document_folders f
    WHERE f.club_id = ${input.clubId}::uuid
      AND f.group_id IS NOT DISTINCT FROM ${input.groupId}::uuid
      AND f.parent_id IS NULL AND f.deleted_at IS NULL AND f.purpose = 'series'
      AND (${input.cursor}::uuid IS NULL OR (f.name, f.id) > (
        SELECT c.name, c.id FROM public.document_folders c WHERE c.id = ${input.cursor}::uuid))
      AND (${input.all} OR app.audience_includes(f.audience_id, ${input.personId}::uuid))
    ORDER BY f.name, f.id
    LIMIT ${input.limit}`);
  return rows.map(toSeries);
}

/** Whether the group is the club's and not archived (a group's series). */
export async function groupActive(tx: Tx, groupId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.groups g
      WHERE g.id = ${groupId}::uuid AND g.archived_at IS NULL) AS ok`);
  return rows[0]?.ok ?? false;
}

export async function insertGoverning(
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
    INSERT INTO public.documents
      (id, club_id, folder_id, group_id, kind, governing_status, name, created_by_person_id)
    VALUES (${input.id}, ${input.clubId}, ${input.folderId}, ${input.groupId}, 'governing', 'draft',
      ${input.name}, ${input.createdBy})`);
}

/** The text's file name, size and hash, as a stored file's would be. */
const TEXT_FIELDS = (body: string) => sql`
  octet_length(${body}::text), encode(sha256(convert_to(${body}::text, 'UTF8')), 'hex')`;

/** A new Markdown version (the document row is locked by the caller), numbered after the last. */
export async function insertTextVersion(
  tx: Tx,
  input: {
    id: string;
    clubId: string;
    documentId: string;
    groupId: string | null;
    fileName: string;
    body: string;
    by: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.document_versions
      (id, club_id, document_id, group_id, number, file_name, body, size, sha256, content_type,
       status, uploaded_by_person_id, uploaded_at, scanned_at)
    VALUES (${input.id}, ${input.clubId}, ${input.documentId}, ${input.groupId},
      (SELECT coalesce(max(v.number), 0) + 1 FROM public.document_versions v
       WHERE v.document_id = ${input.documentId}::uuid),
      ${input.fileName}, ${input.body}, ${TEXT_FIELDS(input.body)}, 'text/markdown; charset=utf-8',
      'clean', ${input.by}, now(), now())`);
}

/** A draft's new text (never an adopted version: the database refuses that too). */
export async function updateDraftText(
  tx: Tx,
  input: { versionId: string; fileName: string; body: string; by: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.document_versions SET
      body = ${input.body}, file_name = ${input.fileName},
      (size, sha256) = (SELECT ${TEXT_FIELDS(input.body)}),
      uploaded_by_person_id = ${input.by}, uploaded_at = now()
    WHERE id = ${input.versionId}::uuid AND adopted_on IS NULL`);
}

export interface TextVersionRow {
  id: string;
  documentId: string;
  number: number;
  sha256: string | null;
  editedByPersonId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  adoptedOn: string | null;
  effectiveFrom: string | null;
  adoptedActivityId: string | null;
  adoptedEventId: string | null;
  adoptedByPersonId: string | null;
  adoptedAt: Date | null;
  /** Only when asked for. */
  body: string | null;
}

type TextVersionSql = {
  id: string;
  document_id: string;
  number: number;
  sha256: string | null;
  uploaded_by_person_id: string | null;
  created_at: string;
  uploaded_at: string | null;
  adopted_on: string | null;
  effective_from: string | null;
  adopted_activity_id: string | null;
  adopted_event_id: string | null;
  adopted_by_person_id: string | null;
  adopted_at: string | null;
  body: string | null;
};

const TEXT_VERSION_COLUMNS = sql`v.id, v.document_id, v.number, v.sha256, v.uploaded_by_person_id,
  v.created_at::text, v.uploaded_at::text, v.adopted_on::text, v.effective_from::text,
  v.adopted_activity_id, v.adopted_event_id, v.adopted_by_person_id, v.adopted_at::text`;

const toTextVersion = (r: TextVersionSql): TextVersionRow => ({
  id: r.id,
  documentId: r.document_id,
  number: r.number,
  sha256: r.sha256,
  editedByPersonId: r.uploaded_by_person_id,
  createdAt: new Date(r.created_at),
  editedAt: r.uploaded_at ? new Date(r.uploaded_at) : null,
  adoptedOn: r.adopted_on,
  effectiveFrom: r.effective_from,
  adoptedActivityId: r.adopted_activity_id,
  adoptedEventId: r.adopted_event_id,
  adoptedByPersonId: r.adopted_by_person_id,
  adoptedAt: r.adopted_at ? new Date(r.adopted_at) : null,
  body: r.body,
});

/** A governing document's Markdown versions, newest first, without their text. */
export async function textVersions(tx: Tx, documentId: string): Promise<TextVersionRow[]> {
  const { rows } = await tx.execute<TextVersionSql>(sql`
    SELECT ${TEXT_VERSION_COLUMNS}, NULL::text AS body FROM public.document_versions v
    WHERE v.document_id = ${documentId}::uuid AND v.body IS NOT NULL
    ORDER BY v.number DESC LIMIT 200`);
  return rows.map(toTextVersion);
}

/** One Markdown version with its text. */
export async function textVersion(tx: Tx, versionId: string): Promise<TextVersionRow | null> {
  const { rows } = await tx.execute<TextVersionSql>(sql`
    SELECT ${TEXT_VERSION_COLUMNS}, v.body FROM public.document_versions v
    WHERE v.id = ${versionId}::uuid AND v.body IS NOT NULL`);
  return rows[0] ? toTextVersion(rows[0]) : null;
}

/** Records the version as adopted (it is locked from now on). */
export async function adoptVersion(
  tx: Tx,
  input: {
    versionId: string;
    adoptedOn: string;
    effectiveFrom: string;
    activityId: string | null;
    eventId: string | null;
    by: string;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.document_versions SET
      adopted_on = ${input.adoptedOn}::date, effective_from = ${input.effectiveFrom}::date,
      adopted_activity_id = ${input.activityId}::uuid, adopted_event_id = ${input.eventId}::uuid,
      adopted_by_person_id = ${input.by}, adopted_at = now()
    WHERE id = ${input.versionId}::uuid AND adopted_on IS NULL`);
}

/** A governing document's status, and the version in force once adopted. */
export async function setGoverning(
  tx: Tx,
  documentId: string,
  input: {
    status: GoverningStatus;
    currentVersionId?: string;
    supersededBy?: string | null;
    name?: string;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.documents SET
      governing_status = ${input.status},
      name = coalesce(${input.name ?? null}, name),
      current_version_id = coalesce(${input.currentVersionId ?? null}::uuid, current_version_id),
      published_at = CASE WHEN ${input.currentVersionId ?? null}::uuid IS NULL THEN published_at
        ELSE now() END,
      superseded_by_document_id = CASE WHEN ${input.supersededBy !== undefined}
        THEN ${input.supersededBy ?? null}::uuid ELSE superseded_by_document_id END
    WHERE id = ${documentId}::uuid`);
}

/** Documents by ID with their names (the ones superseded, or superseding). */
export async function documentRefs(
  tx: Tx,
  input: { ids?: readonly string[]; supersededBy?: string },
): Promise<{ id: string; name: string; status: GoverningStatus | null; kind: string }[]> {
  const ids = input.ids ? `{${input.ids.join(",")}}` : null;
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    governing_status: GoverningStatus | null;
    kind: string;
  }>(sql`
    SELECT d.id, d.name, d.governing_status, d.kind FROM public.documents d
    WHERE d.deleted_at IS NULL AND (
      (${ids}::uuid[] IS NOT NULL AND d.id = ANY (${ids}::uuid[]))
      OR (${input.supersededBy ?? null}::uuid IS NOT NULL
          AND d.superseded_by_document_id = ${input.supersededBy ?? null}::uuid))
    ORDER BY d.name, d.id
    LIMIT 50`);
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.governing_status, kind: r.kind }));
}

/** Whether the activity or event is the club's (the meeting that adopted a document). */
export async function meetingExists(
  tx: Tx,
  meeting: { kind: "activity" | "event"; id: string },
): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    meeting.kind === "activity"
      ? sql`SELECT EXISTS (SELECT 1 FROM public.activities a WHERE a.id = ${meeting.id}::uuid) AS ok`
      : sql`SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = ${meeting.id}::uuid) AS ok`,
  );
  return rows[0]?.ok ?? false;
}

/** The document that superseded this one. */
export async function superseder(
  tx: Tx,
  documentId: string,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await tx.execute<{ id: string; name: string }>(sql`
    SELECT s.id, s.name FROM public.documents d
    JOIN public.documents s ON s.id = d.superseded_by_document_id
    WHERE d.id = ${documentId}::uuid`);
  return rows[0] ?? null;
}
