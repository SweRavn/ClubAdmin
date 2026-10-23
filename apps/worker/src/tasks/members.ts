// SPDX-License-Identifier: AGPL-3.0-only
// Member register exports (P1.2): members:export writes the CSV of a queued
// export to object storage (the insert trigger on member_exports enqueues
// it), in batches into a multipart upload so the result is never held in
// memory; members:expire_exports deletes files after 24 hours and fails
// exports that never finished. Payloads hold IDs only.

import { type Database, sql, type Tx } from "@clubadmin/db";
import { type Catalogue, catalogues, DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import {
  CONSENT_PURPOSES,
  type MemberExportColumn,
  type RegisterFilter,
  z,
} from "@clubadmin/shared";
import type { Task } from "graphile-worker";

import { UTF8_BOM } from "../csv.ts";
import { exportBatch, exportHeader, exportLine } from "../presenters/member-export.ts";

const JOB = "members:export";
const BATCH = 1000;
/** S3 parts other than the last must be at least 5 MiB. */
const PART_BYTES = 5 * 1024 * 1024;
export const EXPORT_HOURS = 24;

const Payload = z.object({ exportId: z.uuid(), clubId: z.uuid() });

type ExportRow = {
  status: string;
  requested_by_person_id: string;
  filter: RegisterFilter;
  columns: MemberExportColumn[];
  include_protected: boolean;
  /** The requester still manages the register (club manager or registrar). */
  allowed: boolean;
  locale: string | null;
  default_locale: string;
  time_zone: string;
};

function translator(locale: Locale): (key: string) => string {
  const find = (catalogue: Catalogue, key: string) => {
    let node: string | Catalogue | undefined = catalogue;
    for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
    return typeof node === "string" ? node : undefined;
  };
  return (key) => find(catalogues[locale], key) ?? find(catalogues.en, key) ?? key;
}

async function fail(db: Database, clubId: string, exportId: string, code: string) {
  await db.withSystem(JOB, { clubId }, (tx) =>
    tx.execute(sql`
      UPDATE public.member_exports SET status = 'failed', error_code = ${code}
      WHERE id = ${exportId} AND status = 'queued'`),
  );
}

async function loadExport(tx: Tx, exportId: string): Promise<ExportRow | null> {
  const { rows } = await tx.execute<ExportRow>(sql`
    SELECT x.status, x.requested_by_person_id, x.filter, x.columns, x.include_protected,
      EXISTS (SELECT 1 FROM public.club_role_assignments r
              WHERE r.club_id = x.club_id AND r.person_id = x.requested_by_person_id
                AND r.role IN ('club_manager', 'registrar') AND r.valid_to IS NULL) AS allowed,
      (SELECT a.locale FROM public.accounts a WHERE a.person_id = x.requested_by_person_id) AS locale,
      c.default_locale, c.time_zone
    FROM public.member_exports x JOIN public.clubs c ON c.id = x.club_id
    WHERE x.id = ${exportId}`);
  return rows[0] ?? null;
}

/** Writes one export; returns the number of members in it (null if there was nothing to do). */
export async function runMemberExport(
  db: Database,
  storage: ObjectStorage | null,
  exportId: string,
  clubId: string,
): Promise<number | null> {
  const row = await db.withSystem(JOB, { clubId }, (tx) => loadExport(tx, exportId));
  if (!row || row.status !== "queued") return null;
  if (!storage) {
    await fail(db, clubId, exportId, "storage_unavailable");
    return null;
  }
  // A requester who lost the role since asking gets nothing.
  if (!row.allowed) {
    await fail(db, clubId, exportId, "not_allowed");
    return null;
  }

  const locale = localeOf(row.locale) ?? localeOf(row.default_locale) ?? DEFAULT_LOCALE;
  const t = translator(locale);
  const key = `exports/${clubId}/${exportId}.csv`;
  const uploadId = await storage.createMultipartUpload(key, "text/csv; charset=utf-8");
  const parts: { partNumber: number; etag: string }[] = [];
  let pending: Buffer[] = [
    Buffer.from(UTF8_BOM + exportHeader(row.columns, row.include_protected, t)),
  ];
  let pendingBytes = pending[0]!.length;
  const flush = async () => {
    const partNumber = parts.length + 1;
    parts.push({
      partNumber,
      etag: await storage.uploadPart(key, uploadId, partNumber, Buffer.concat(pending)),
    });
    pending = [];
    pendingBytes = 0;
  };

  let count = 0;
  try {
    let after: { sortName: string; personId: string } | null = null;
    for (;;) {
      const batch = await db.withSystem(JOB, { clubId }, (tx) =>
        exportBatch(tx, clubId, {
          filter: row.filter,
          includeProtected: row.include_protected,
          timeZone: row.time_zone,
          after,
          limit: BATCH,
        }),
      );
      for (const member of batch) {
        const line = Buffer.from(
          exportLine(member, row.columns, {
            includeProtected: row.include_protected,
            consentPurposes: CONSENT_PURPOSES,
            t,
          }),
        );
        pending.push(line);
        pendingBytes += line.length;
      }
      count += batch.length;
      if (pendingBytes >= PART_BYTES) await flush();
      if (batch.length < BATCH) break;
      const last = batch.at(-1)!;
      after = { sortName: last.sort_name, personId: last.person_id };
    }
    if (pendingBytes > 0 || parts.length === 0) await flush();
    await storage.completeMultipartUpload(key, uploadId, parts);
  } catch (error) {
    await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    throw error;
  }

  await db.withSystem(JOB, { clubId }, (tx) =>
    tx.execute(sql`
      UPDATE public.member_exports
      SET status = 'ready', row_count = ${count}, object_key = ${key},
        expires_at = now() + make_interval(hours => ${EXPORT_HOURS}), error_code = NULL
      WHERE id = ${exportId} AND status = 'queued'`),
  );
  return count;
}

export function memberExportTask(db: Database, storage: ObjectStorage | null): Task {
  return async (payload, helpers) => {
    const { exportId, clubId } = Payload.parse(payload);
    try {
      const count = await runMemberExport(db, storage, exportId, clubId);
      helpers.logger.info("member export", { exportId, rows: count });
    } catch (error) {
      // Graphile Worker retries; after the last attempt the export fails.
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        await fail(db, clubId, exportId, "generation_failed");
      }
      throw error;
    }
  };
}

/**
 * Deletes the files of exports older than 24 hours (status expired) and
 * fails exports still queued after two hours (the job gave up or was lost).
 */
export async function expireMemberExports(
  db: Database,
  storage: ObjectStorage | null,
): Promise<{ expired: number; failed: number }> {
  const { rows } = await db.withSystem("members:expire_exports", {}, (tx) =>
    tx.execute<{ id: string; club_id: string; status: string; object_key: string | null }>(sql`
      SELECT id, club_id, status, object_key FROM public.member_exports
      WHERE (status = 'ready' AND expires_at <= now())
         OR (status = 'queued' AND created_at < now() - interval '2 hours')`),
  );
  const result = { expired: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "queued") {
      await fail(db, row.club_id, row.id, "timeout");
      result.failed++;
      continue;
    }
    // Without storage the file cannot be deleted: try again next time.
    if (!storage) continue;
    if (row.object_key) await storage.deleteObject(row.object_key);
    await db.withSystem("members:expire_exports", { clubId: row.club_id }, (tx) =>
      tx.execute(sql`
        UPDATE public.member_exports SET status = 'expired', object_key = NULL
        WHERE id = ${row.id} AND status = 'ready'`),
    );
    result.expired++;
  }
  return result;
}

export function expireMemberExportsTask(db: Database, storage: ObjectStorage | null): Task {
  return async (_payload, helpers) => {
    const result = await expireMemberExports(db, storage);
    if (result.expired + result.failed > 0) helpers.logger.info("member exports expired", result);
  };
}

/**
 * Member imports (P1.3b, docs/gdpr.md): seven days after an import ends
 * (done, failed or cancelled) its staging rows and any uploaded file are
 * deleted; the import stays as a record with its counts. An import left in
 * review (or never uploaded) for seven days is cancelled first.
 */
export async function purgeMemberImports(
  db: Database,
  storage: ObjectStorage | null,
): Promise<{ purged: number; abandoned: number }> {
  const { rows } = await db.withSystem("members:purge_imports", {}, (tx) =>
    tx.execute<{ id: string; club_id: string; status: string; object_key: string | null }>(sql`
      SELECT id, club_id, status, object_key FROM public.member_imports
      WHERE purged_at IS NULL AND (
        (status IN ('done', 'failed', 'cancelled') AND finished_at < now() - interval '7 days')
        OR (status IN ('uploaded', 'review') AND updated_at < now() - interval '7 days'))`),
  );
  const result = { purged: 0, abandoned: 0 };
  for (const row of rows) {
    // Without storage the file cannot be deleted: try again next time.
    if (row.object_key) {
      if (!storage) continue;
      await storage.deleteObject(row.object_key);
    }
    const abandoned = row.status === "uploaded" || row.status === "review";
    await db.withSystem("members:purge_imports", { clubId: row.club_id }, async (tx) => {
      await tx.execute(sql`DELETE FROM public.member_import_rows WHERE import_id = ${row.id}`);
      await tx.execute(sql`
        UPDATE public.member_imports SET purged_at = now(), object_key = NULL, columns = '[]'::jsonb,
          status = CASE WHEN status IN ('uploaded', 'review') THEN 'cancelled' ELSE status END,
          finished_at = coalesce(finished_at, now())
        WHERE id = ${row.id}`);
    });
    result.purged++;
    if (abandoned) result.abandoned++;
  }
  return result;
}

export function purgeMemberImportsTask(db: Database, storage: ObjectStorage | null): Task {
  return async (_payload, helpers) => {
    const result = await purgeMemberImports(db, storage);
    if (result.purged > 0) helpers.logger.info("member imports purged", result);
  };
}
