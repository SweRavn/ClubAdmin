// SPDX-License-Identifier: AGPL-3.0-only
// The file archive's jobs (P2.2) against the local object storage: a clean
// upload becomes the file's current version (with its SHA-256), an infected
// or mislabelled one is deleted and never shown, a version uploaded after
// its file was deleted is not kept, deleted files' objects are removed and
// abandoned uploads are cleaned up.

import { createHash } from "node:crypto";

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { ObjectStorage, objectStorageConfig } from "@clubadmin/server-kit/object-storage";
import type { VirusScanner } from "@clubadmin/server-kit/virus-scan";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupDocuments,
  deleteDocumentObjects,
  matchesType,
  runDeletionDates,
  scanVersion,
} from "./documents.ts";

loadEnvFiles();
const config = objectStorageConfig({
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION ?? "garage",
  S3_BUCKET_FILES: process.env.S3_BUCKET_FILES ?? "clubadmin-files",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
});
if (!config) throw new Error("S3_* must be set (pnpm dev:services)");
const storage = new ObjectStorage(config);

/** EICAR is found; everything else is clean. */
const scanner: VirusScanner = {
  scan: (data) =>
    Promise.resolve(
      data.includes("EICAR")
        ? { result: "infected", signature: "Eicar-Test-Signature" }
        : { result: "clean" },
    ),
};

let t: TestDatabase;
const club = uuidv7();
const uploader = uuidv7();
let folder: string;

async function admin<T extends Record<string, unknown>>(statement: string, params: unknown[] = []) {
  return (await t.query<T>("admin", statement, params)).rows;
}

/** A file with one version stored (or not) in the given state. */
async function version(
  data: Buffer | null,
  options: { status?: string; contentType?: string; size?: number; documentId?: string } = {},
) {
  const documentId = options.documentId ?? uuidv7();
  const versionId = uuidv7();
  const key = `documents/${club}/${documentId}/${versionId}`;
  if (!options.documentId) {
    await admin("INSERT INTO documents (id, club_id, folder_id, name) VALUES ($1, $2, $3, 'Fil')", [
      documentId,
      club,
      folder,
    ]);
  }
  const [{ number }] = (await admin<{ number: number }>(
    "SELECT coalesce(max(number), 0) + 1 AS number FROM document_versions WHERE document_id = $1",
    [documentId],
  )) as [{ number: number }];
  await admin(
    `INSERT INTO document_versions (id, club_id, document_id, number, object_key, file_name, size,
       content_type, status, uploaded_by_person_id)
     VALUES ($1, $2, $3, $4, $5, 'fil.pdf', $6, $7, $8, $9)`,
    [
      versionId,
      club,
      documentId,
      number,
      key,
      options.size ?? data?.length ?? 10,
      options.contentType ?? "application/pdf",
      options.status ?? "pending",
      uploader,
    ],
  );
  if (data) await storage.putObject(key, data, "application/octet-stream");
  return { documentId, versionId, key };
}

const state = async (versionId: string) =>
  (
    await admin<{ status: string; sha256: string | null; object_deleted_at: Date | null }>(
      "SELECT status, sha256, object_deleted_at FROM document_versions WHERE id = $1",
      [versionId],
    )
  )[0]!;
const current = async (documentId: string) =>
  (
    await admin<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM documents WHERE id = $1",
      [documentId],
    )
  )[0]!.current_version_id;
const stored = async (key: string) =>
  (await storage.getObject(key, { maxBytes: 1_000_000 })) !== null;

const deps = () => ({ db: t.db, storage, scanner });
const PDF = Buffer.from("%PDF-1.7\nhello\n%%EOF\n");

beforeAll(async () => {
  t = await createTestDatabase();
  await admin(
    "INSERT INTO people (id, given_name, family_name, birth_date) VALUES ($1, 'Upp', 'Laddare', '1980-01-01')",
    [uploader],
  );
  const c = await t.connect("admin");
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Dok IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `dok-${club.slice(-8)}`],
    );
    await c.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, uploader],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
  const [audience] = await admin<{ id: string }>(
    "INSERT INTO audiences (club_id) VALUES ($1) RETURNING id",
    [club],
  );
  await admin("INSERT INTO audience_entries (club_id, audience_id, kind) VALUES ($1, $2, 'club')", [
    club,
    audience!.id,
  ]);
  folder = (
    await admin<{ id: string }>(
      "INSERT INTO document_folders (club_id, name, audience_id) VALUES ($1, 'Policyer', $2) RETURNING id",
      [club, audience!.id],
    )
  )[0]!.id;
});
afterAll(async () => {
  await t?.drop();
});

describe("documents:scan", () => {
  it("makes a clean upload the current version, with its SHA-256", async () => {
    const v1 = await version(PDF);
    expect(await scanVersion(deps(), club, v1.versionId)).toBe("clean");
    const after = await state(v1.versionId);
    expect(after.status).toBe("clean");
    expect(after.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(await current(v1.documentId)).toBe(v1.versionId);
    // A newer version becomes current; scanning again does nothing.
    const v2 = await version(PDF, { documentId: v1.documentId });
    expect(await scanVersion(deps(), club, v2.versionId)).toBe("clean");
    expect(await current(v1.documentId)).toBe(v2.versionId);
    expect(await scanVersion(deps(), club, v2.versionId)).toBe("skipped");
    const [audit] = await admin<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit.events WHERE resource_id = $1 AND action = 'document.version.verified'",
      [v1.documentId],
    );
    expect(audit!.count).toBe(2);
  });

  it("deletes an infected upload and never shows it", async () => {
    const bad = await version(Buffer.from("%PDF-1.4 X5O!P%@AP EICAR test"));
    expect(await scanVersion(deps(), club, bad.versionId)).toBe("infected");
    expect((await state(bad.versionId)).status).toBe("infected");
    expect((await state(bad.versionId)).object_deleted_at).not.toBeNull();
    expect(await current(bad.documentId)).toBeNull();
    expect(await stored(bad.key)).toBe(false);
  });

  it("refuses a file that is missing, of another size or not of its type", async () => {
    const missing = await version(null, { size: 20 });
    expect(await scanVersion(deps(), club, missing.versionId)).toBe("failed");
    const exe = await version(Buffer.from("MZ\x90\x00 not a pdf"));
    expect(await scanVersion(deps(), club, exe.versionId)).toBe("failed");
    expect(await stored(exe.key)).toBe(false);
    const short = await version(PDF, { size: PDF.length + 5 });
    expect(await scanVersion(deps(), club, short.versionId)).toBe("failed");
  });

  it("does not keep a version uploaded after its file was deleted", async () => {
    const late = await version(PDF);
    await admin("UPDATE documents SET deleted_at = now() WHERE id = $1", [late.documentId]);
    expect(await scanVersion(deps(), club, late.versionId)).toBe("failed");
    expect(await stored(late.key)).toBe(false);
  });
});

describe("documents:delete_objects and documents:cleanup", () => {
  it("removes the stored versions of deleted files", async () => {
    const file = await version(PDF);
    await scanVersion(deps(), club, file.versionId);
    expect(await deleteDocumentObjects(t.db, storage, club, [file.documentId])).toBe(0);
    await admin("UPDATE documents SET deleted_at = now() WHERE id = $1", [file.documentId]);
    expect(await deleteDocumentObjects(t.db, storage, club, [file.documentId])).toBe(1);
    expect(await stored(file.key)).toBe(false);
    expect((await state(file.versionId)).object_deleted_at).not.toBeNull();
  });

  it("marks abandoned uploads failed", async () => {
    const abandoned = await version(null, { status: "uploading" });
    const fresh = await version(null, { status: "uploading" });
    await admin(
      "UPDATE document_versions SET created_at = now() - interval '2 hours' WHERE id = $1",
      [abandoned.versionId],
    );
    expect(await cleanupDocuments(t.db, storage)).toBeGreaterThanOrEqual(1);
    expect((await state(abandoned.versionId)).status).toBe("failed");
    expect((await state(fresh.versionId)).status).toBe("uploading");
  });
});

describe("matchesType", () => {
  it("knows the allowed formats' signatures", () => {
    expect(matchesType("application/pdf", PDF)).toBe(true);
    expect(
      matchesType("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
    expect(
      matchesType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Buffer.from("PK\x03\x04rest"),
      ),
    ).toBe(true);
    expect(matchesType("text/csv", Buffer.from("a;b\n1;2\n"))).toBe(true);
    expect(matchesType("text/csv", Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(matchesType("application/pdf", Buffer.from("MZ"))).toBe(false);
    expect(matchesType("application/x-msdownload", Buffer.from("MZ"))).toBe(false);
  });
});

describe("publishing and deletion dates (P2.2 part B)", () => {
  it("publishes a clean version, and asks for push only when the uploader did", async () => {
    const quiet = await version(PDF);
    await scanVersion(deps(), club, quiet.versionId);
    const loud = await version(PDF);
    await admin("UPDATE document_versions SET notify = true WHERE id = $1", [loud.versionId]);
    await scanVersion(deps(), club, loud.versionId);
    const published = await admin<{ published: boolean }>(
      "SELECT published_at IS NOT NULL AS published FROM documents WHERE id = $1",
      [quiet.documentId],
    );
    expect(published[0]!.published).toBe(true);
    const events = await admin<{ document_id: string }>(
      "SELECT payload->>'documentId' AS document_id FROM outbox.events WHERE type = 'document.published'",
    );
    expect(events.map((e) => e.document_id)).toEqual([loud.documentId]);
  });

  it("tells the uploader a week before and deletes on the day", async () => {
    const soon = await version(PDF);
    const due = await version(PDF);
    const later = await version(PDF);
    await admin("UPDATE documents SET delete_after = current_date + 5 WHERE id = $1", [
      soon.documentId,
    ]);
    await admin("UPDATE documents SET delete_after = current_date WHERE id = $1", [due.documentId]);
    await admin("UPDATE documents SET delete_after = current_date + 30 WHERE id = $1", [
      later.documentId,
    ]);
    expect(await runDeletionDates(t.db)).toEqual({ noticed: 1, deleted: 1 });
    // The notice is sent once.
    expect(await runDeletionDates(t.db)).toEqual({ noticed: 0, deleted: 0 });
    const rows = await admin<{ id: string; deleted: boolean; noticed: boolean }>(
      `SELECT id, deleted_at IS NOT NULL AS deleted, deletion_notice_sent_at IS NOT NULL AS noticed
       FROM documents WHERE id = ANY($1::uuid[])`,
      [[soon.documentId, due.documentId, later.documentId]],
    );
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(soon.documentId)).toMatchObject({ deleted: false, noticed: true });
    expect(by.get(due.documentId)).toMatchObject({ deleted: true });
    expect(by.get(later.documentId)).toMatchObject({ deleted: false, noticed: false });
    const events = await admin<{ type: string }>(
      "SELECT type FROM outbox.events WHERE payload->>'documentId' = $1 OR payload->'documentIds' ? $1",
      [due.documentId],
    );
    expect(events.map((e) => e.type)).toContain("documents.deleted");
  });
});
