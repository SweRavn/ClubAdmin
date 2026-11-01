// SPDX-License-Identifier: AGPL-3.0-only
// privacy:export (P1.8b, ADR 0041): writes one "download my data" file. The
// insert trigger on data_exports queues it; the API's job runner runs it
// (ADR 0033: it reads through the domain services and the presenter). The
// ZIP (data.json and index.html) is deflated as it is written and uploaded
// in parts, one part of the export at a time, so neither the file nor the
// person's data is held in memory. Then the requester gets the notice
// privacy.export.ready, which links to the page, never to the file.

import { type Database, outbox, sql } from "@clubadmin/db";
import { DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import { DATA_EXPORT_DAYS, DATA_EXPORT_PREFIX } from "@clubadmin/shared";
import { Zip, ZipDeflate } from "fflate";

import type { AuthorizationService } from "../authorization/index.ts";
import { type CollectDeps, collectExport, exportHeader } from "./presenters/data-export.collect.ts";
import {
  htmlClose,
  htmlOpen,
  htmlPart,
  jsonClose,
  jsonOpen,
  jsonPart,
  type Names,
} from "./presenters/data-export.render.ts";

const JOB = "privacy:export";
/** S3 parts other than the last must be at least 5 MiB. */
const PART_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86_400_000;

export interface DataExportJobDeps extends CollectDeps {
  storage: ObjectStorage | null;
  authorization: AuthorizationService;
  now?: () => Date;
}

interface JobRow {
  status: string;
  subject_person_id: string;
  requested_by_person_id: string;
  locale: string;
  time_zone: string | null;
  allowed: boolean;
  [key: string]: unknown;
}

async function fail(db: Database, exportId: string, code: string): Promise<"failed"> {
  await db.withSystem(JOB, {}, (tx) =>
    tx.execute(sql`
      UPDATE public.data_exports SET status = 'failed', error_code = ${code}
      WHERE id = ${exportId} AND status = 'queued'`),
  );
  return "failed";
}

/** Writes one export; returns its new status (null if there was nothing to do). */
export async function runDataExport(
  deps: DataExportJobDeps,
  exportId: string,
): Promise<"ready" | "failed" | null> {
  const { rows } = await deps.db.withSystem(JOB, {}, (tx) =>
    tx.execute<JobRow>(sql`
      SELECT x.status, x.subject_person_id, x.requested_by_person_id, x.locale,
        (SELECT a.time_zone FROM public.accounts a
         WHERE a.person_id = x.requested_by_person_id) AS time_zone,
        (x.subject_person_id = x.requested_by_person_id OR EXISTS (
          SELECT 1 FROM public.guardianships g
          WHERE g.guardian_person_id = x.requested_by_person_id
            AND g.ward_person_id = x.subject_person_id
            AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active'
            AND g.valid_to IS NULL)) AS allowed
      FROM public.data_exports x WHERE x.id = ${exportId}`),
  );
  const row = rows[0];
  if (!row || row.status !== "queued") return null;
  // A guardian who is no longer one gets nothing.
  if (!row.allowed) return fail(deps.db, exportId, "not_allowed");
  const storage = deps.storage;
  if (!storage) return fail(deps.db, exportId, "storage_unavailable");

  const now = deps.now?.() ?? new Date();
  const locale: Locale = localeOf(row.locale) ?? DEFAULT_LOCALE;
  const subjectId = row.subject_person_id;
  const requesterId = row.requested_by_person_id;
  const authz = await deps.authorization.forPerson(requesterId, `${JOB}:${exportId}`);
  const header = exportHeader(locale, subjectId, requesterId, now);
  const timeZone = row.time_zone ?? "Europe/Stockholm";

  const key = `${DATA_EXPORT_PREFIX}${exportId}.zip`;
  const uploadId = await storage.createMultipartUpload(key, "application/zip");
  const parts: { partNumber: number; etag: string }[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) {
      zipError = error;
      return;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    totalBytes += chunk.length;
  });
  const flush = async (force: boolean) => {
    if (zipError) throw zipError;
    if (pendingBytes === 0 || (!force && pendingBytes < PART_BYTES)) return;
    const partNumber = parts.length + 1;
    const body = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    parts.push({ partNumber, etag: await storage.uploadPart(key, uploadId, partNumber, body) });
  };
  const encoder = new TextEncoder();
  const entry = async (filename: string, pieces: AsyncIterable<string>) => {
    const file = new ZipDeflate(filename, { level: 6 });
    file.mtime = now;
    zip.add(file);
    for await (const piece of pieces) {
      file.push(encoder.encode(piece));
      await flush(false);
    }
    file.push(new Uint8Array(0), true);
    await flush(false);
  };

  async function* json(): AsyncGenerator<string> {
    yield jsonOpen(header);
    const names: Names = {};
    let first = true;
    for await (const { part, names: mentioned } of collectExport(deps, authz, locale, subjectId)) {
      Object.assign(names, mentioned);
      yield jsonPart(part, first);
      first = false;
    }
    yield jsonClose(names);
  }

  async function* html(): AsyncGenerator<string> {
    let opened = false;
    for await (const { part, names } of collectExport(deps, authz, locale, subjectId)) {
      if (!opened) {
        yield htmlOpen(locale, header, names[subjectId]?.name ?? "");
        opened = true;
      }
      yield htmlPart({ locale, timeZone, names }, part);
    }
    yield htmlClose();
  }

  try {
    await entry("data.json", json());
    await entry("index.html", html());
    zip.end();
    await flush(true);
    if (parts.length === 0) {
      parts.push({
        partNumber: 1,
        etag: await storage.uploadPart(key, uploadId, 1, Buffer.alloc(0)),
      });
    }
    await storage.completeMultipartUpload(key, uploadId, parts);
  } catch (error) {
    await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    throw error;
  }

  await deps.db.withSystem(JOB, {}, async (tx) => {
    await tx.execute(sql`
      UPDATE public.data_exports
      SET status = 'ready', object_key = ${key}, size_bytes = ${totalBytes},
        ready_at = ${now.toISOString()},
        expires_at = ${new Date(now.getTime() + DATA_EXPORT_DAYS * DAY_MS).toISOString()},
        error_code = NULL
      WHERE id = ${exportId} AND status = 'queued'`);
    await outbox.publish(tx, "privacy.export.ready", {
      exportId,
      requestedByPersonId: requesterId,
    });
  });
  return "ready";
}
