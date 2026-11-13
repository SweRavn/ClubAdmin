// SPDX-License-Identifier: AGPL-3.0-only
// The file archive's jobs (P2.2, ADR 0049 decision 7):
// - documents:scan (outbox: a version was uploaded): reads the stored file,
//   checks its size and that its first bytes match its type, scans it with
//   ClamAV and records the verdict. A clean version becomes the file's
//   current one (unless a newer one already is); an infected or failed one
//   is deleted from storage and never shown.
// - documents:delete_objects (outbox: files were deleted): deletes their
//   stored versions.
// - documents:cleanup (hourly): uploads never finished (their links expired
//   long ago) are marked failed and their objects (if any) deleted. A
//   version uploaded after its file was deleted is deleted by its scan.
// IDs only in logs; never file names or contents.

import { createHash } from "node:crypto";

import { audit, type Database, outbox, type OutboxHandler, sql } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import type { VirusScanner } from "@clubadmin/server-kit/virus-scan";
import { DOMAIN_EVENTS, z } from "@clubadmin/shared";
import type { Task } from "graphile-worker";

export function documentsHandler(): OutboxHandler {
  return {
    name: "documents",
    types: ["document.version.uploaded", "documents.deleted"],
    async handle(event, tx) {
      if (event.type === "document.version.uploaded") {
        const payload = DOMAIN_EVENTS["document.version.uploaded"].parse(event.payload);
        await tx.execute(sql`
          SELECT graphile_worker.add_job('documents:scan', ${JSON.stringify(payload)}::json,
            job_key := ${`documents:scan:${payload.versionId}`}, max_attempts := 10)`);
        return;
      }
      const payload = DOMAIN_EVENTS["documents.deleted"].parse(event.payload);
      await tx.execute(sql`
        SELECT graphile_worker.add_job('documents:delete_objects', ${JSON.stringify(payload)}::json,
          max_attempts := 10)`);
    },
  };
}

/**
 * Whether the file's first bytes match its type (a renamed executable is
 * refused): the signatures of the binary formats on the allow list; text
 * formats must not contain NUL bytes.
 */
export function matchesType(contentType: string, data: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  const ascii = (offset: number, text: string) =>
    data.subarray(offset, offset + text.length).toString("latin1") === text;
  switch (contentType) {
    case "application/pdf":
      return ascii(0, "%PDF-");
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
      return ascii(4, "ftyp");
    case "application/rtf":
      return ascii(0, "{\\rtf");
    // Office Open XML and OpenDocument are ZIP files.
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.oasis.opendocument.text":
    case "application/vnd.oasis.opendocument.spreadsheet":
    case "application/vnd.oasis.opendocument.presentation":
      return starts(0x50, 0x4b, 0x03, 0x04);
    // The old Office formats are OLE compound files.
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "text/plain":
    case "text/csv":
      return !data.includes(0);
    default:
      return false;
  }
}

interface PendingVersion {
  documentId: string;
  number: number;
  objectKey: string;
  size: number;
  contentType: string;
  notify: boolean;
}

export type ScanOutcome = "clean" | "infected" | "failed" | "skipped";

const ScanPayload = z.object({ clubId: z.uuid(), versionId: z.uuid() });

/** Scans one uploaded version and records the verdict. */
export async function scanVersion(
  deps: { db: Database; storage: ObjectStorage | null; scanner: VirusScanner | null },
  clubId: string,
  versionId: string,
): Promise<ScanOutcome> {
  const { db, storage, scanner } = deps;
  const { rows } = await db.withSystem("documents:scan", { clubId }, (tx) =>
    tx.execute<{
      document_id: string;
      number: number;
      object_key: string;
      size: string;
      content_type: string;
      notify: boolean;
      deleted: boolean;
    }>(sql`
      SELECT v.document_id, v.number, v.object_key, v.size::text, v.content_type, v.notify,
        d.deleted_at IS NOT NULL AS deleted
      FROM public.document_versions v JOIN public.documents d ON d.id = v.document_id
      WHERE v.id = ${versionId}::uuid AND v.status = 'pending'`),
  );
  const row = rows[0];
  if (!row) return "skipped";
  if (!storage) throw new Error("documents:scan needs object storage (S3_*)");
  const version: PendingVersion = {
    documentId: row.document_id,
    number: row.number,
    objectKey: row.object_key,
    size: Number(row.size),
    contentType: row.content_type,
    notify: row.notify,
  };
  // The file was deleted meanwhile: its upload is not kept.
  const data = row.deleted
    ? null
    : await storage.getObject(version.objectKey, { maxBytes: version.size });
  let outcome: Exclude<ScanOutcome, "skipped">;
  if (!data || data.length !== version.size || !matchesType(version.contentType, data)) {
    outcome = "failed";
  } else if (scanner) {
    outcome = (await scanner.scan(data)).result;
  } else {
    // Not configured (outside production only, virusScanConfigIssues).
    outcome = "clean";
  }
  if (outcome !== "clean") await storage.deleteObject(version.objectKey);
  const sha256 =
    outcome === "clean" && data ? createHash("sha256").update(data).digest("hex") : null;
  await db.withSystem("documents:scan", { clubId }, async (tx) => {
    const { rows: updated } = await tx.execute<{ id: string }>(sql`
      UPDATE public.document_versions SET status = ${outcome}, sha256 = ${sha256}, scanned_at = now(),
        object_deleted_at = CASE WHEN ${outcome} = 'clean' THEN NULL ELSE now() END
      WHERE id = ${versionId}::uuid AND status = 'pending' RETURNING id`);
    if (updated.length === 0) return;
    if (outcome === "clean") {
      // The newest clean version is the file's current one, published now.
      const { rows: current } = await tx.execute<{ id: string }>(sql`
        UPDATE public.documents d SET current_version_id = ${versionId}, published_at = now()
        WHERE d.id = ${version.documentId}::uuid AND d.deleted_at IS NULL
          AND (d.current_version_id IS NULL OR (
            SELECT c.number FROM public.document_versions c WHERE c.id = d.current_version_id) < ${version.number})
        RETURNING d.id`);
      // Push to the file's readers when its uploader asked (ADR 0049 decision 9).
      if (current.length > 0 && version.notify) {
        await outbox.publish(tx, "document.published", {
          clubId,
          documentId: version.documentId,
          versionId,
        });
      }
    }
    await audit.record(tx, {
      action: "document.version.verified",
      resourceType: "document",
      resourceId: version.documentId,
      changedFields: ["status"],
    });
  });
  return outcome;
}

export function scanTask(deps: {
  db: Database;
  storage: ObjectStorage | null;
  scanner: VirusScanner | null;
}): Task {
  return async (payload, helpers) => {
    const { clubId, versionId } = ScanPayload.parse(payload);
    const outcome = await scanVersion(deps, clubId, versionId);
    helpers.logger.info("document version scanned", { clubId, versionId, outcome });
  };
}

/** Deletes the stored versions of deleted files. */
export async function deleteDocumentObjects(
  db: Database,
  storage: ObjectStorage | null,
  clubId: string,
  documentIds: readonly string[],
): Promise<number> {
  if (!storage) return 0;
  const { rows } = await db.withSystem("documents:delete_objects", { clubId }, (tx) =>
    tx.execute<{ id: string; object_key: string }>(sql`
      SELECT v.id, v.object_key FROM public.document_versions v
      JOIN public.documents d ON d.id = v.document_id
      WHERE v.document_id = ANY(${`{${documentIds.join(",")}}`}::uuid[])
        AND d.deleted_at IS NOT NULL AND v.object_deleted_at IS NULL`),
  );
  for (const row of rows) {
    await storage.deleteObject(row.object_key);
    await db.withSystem("documents:delete_objects", { clubId }, (tx) =>
      tx.execute(sql`
        UPDATE public.document_versions SET object_deleted_at = now(),
          status = CASE WHEN status IN ('uploading', 'pending') THEN 'failed' ELSE status END
        WHERE id = ${row.id}::uuid`),
    );
  }
  return rows.length;
}

export function deleteObjectsTask(db: Database, storage: ObjectStorage | null): Task {
  return async (payload, helpers) => {
    const { clubId, documentIds } = DOMAIN_EVENTS["documents.deleted"].parse(payload);
    const deleted = await deleteDocumentObjects(db, storage, clubId, documentIds);
    helpers.logger.info("deleted files' objects removed", { clubId, objects: deleted });
  };
}

/** Upload links last 15 minutes; an upload not confirmed after this is abandoned. */
const ABANDONED_AFTER = "1 hour";
const CLEANUP_BATCH = 500;

/** Abandoned uploads become failed (their objects deleted, if any). Returns the count. */
export async function cleanupDocuments(
  db: Database,
  storage: ObjectStorage | null,
): Promise<number> {
  if (!storage) return 0;
  const { rows } = await db.withSystem("documents:cleanup", {}, (tx) =>
    tx.execute<{ id: string; club_id: string; object_key: string }>(sql`
      SELECT v.id, v.club_id, v.object_key FROM public.document_versions v
      WHERE v.status = 'uploading' AND v.created_at < now() - ${ABANDONED_AFTER}::interval
      ORDER BY v.created_at LIMIT ${CLEANUP_BATCH}`),
  );
  for (const row of rows) {
    await storage.deleteObject(row.object_key);
    await db.withSystem("documents:cleanup", { clubId: row.club_id }, (tx) =>
      tx.execute(sql`
        UPDATE public.document_versions SET status = 'failed', object_deleted_at = now()
        WHERE id = ${row.id}::uuid AND status = 'uploading'`),
    );
  }
  return rows.length;
}

export function cleanupTask(db: Database, storage: ObjectStorage | null): Task {
  return async (_payload, helpers) => {
    const cleaned = await cleanupDocuments(db, storage);
    if (cleaned > 0) helpers.logger.info("document uploads cleaned up", { versions: cleaned });
  };
}

/** The notice to the uploader is sent this many days before a deletion date. */
const DELETION_NOTICE_DAYS = 7;

/**
 * Deletion dates (P2.2 part B, ADR 0049 decision 8): the uploader is told a
 * week before; on the day the file is deleted (rows kept, marked deleted;
 * its objects removed by documents:delete_objects). Dates are UTC days.
 */
export async function runDeletionDates(
  db: Database,
): Promise<{ noticed: number; deleted: number }> {
  const { rows } = await db.withSystem("documents:deletion_dates", {}, (tx) =>
    tx.execute<{ id: string; club_id: string; due: boolean }>(sql`
      SELECT d.id, d.club_id, d.delete_after <= (now() AT TIME ZONE 'UTC')::date AS due
      FROM public.documents d
      WHERE d.delete_after IS NOT NULL AND d.deleted_at IS NULL
        AND d.delete_after <= (now() AT TIME ZONE 'UTC')::date + ${DELETION_NOTICE_DAYS}::int
        AND (d.deletion_notice_sent_at IS NULL OR d.delete_after <= (now() AT TIME ZONE 'UTC')::date)
      ORDER BY d.delete_after, d.id LIMIT 1000`),
  );
  const result = { noticed: 0, deleted: 0 };
  for (const row of rows) {
    await db.withSystem("documents:deletion_dates", { clubId: row.club_id }, async (tx) => {
      if (row.due) {
        const { rows: deleted } = await tx.execute<{ id: string }>(sql`
          UPDATE public.documents SET deleted_at = now()
          WHERE id = ${row.id}::uuid AND deleted_at IS NULL RETURNING id`);
        if (deleted.length === 0) return;
        await audit.record(tx, {
          action: "document.deleted",
          resourceType: "document",
          resourceId: row.id,
          changedFields: ["delete_after"],
        });
        await outbox.publish(tx, "documents.deleted", {
          clubId: row.club_id,
          documentIds: [row.id],
        });
        result.deleted++;
        return;
      }
      const { rows: marked } = await tx.execute<{ id: string }>(sql`
        UPDATE public.documents SET deletion_notice_sent_at = now()
        WHERE id = ${row.id}::uuid AND deletion_notice_sent_at IS NULL RETURNING id`);
      if (marked.length === 0) return;
      await outbox.publish(tx, "document.deletion_soon", {
        clubId: row.club_id,
        documentId: row.id,
      });
      result.noticed++;
    });
  }
  return result;
}

export function deletionDatesTask(db: Database): Task {
  return async (_payload, helpers) => {
    const result = await runDeletionDates(db);
    if (result.noticed + result.deleted > 0) helpers.logger.info("document deletion dates", result);
  };
}
