// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2, ADR 0049) through the API against the local object
// storage: folders of the club and a group, audiences of every entry kind
// (guardians included), uploads to pre-signed links, versions that are only
// visible after a clean scan (the worker's part is simulated here; the
// worker's tests scan), downloads (audited for narrow audiences), the
// storage limit, moving and deleting.

import { sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { ObjectStorage, objectStorageConfig } from "@clubadmin/server-kit/object-storage";
import type {
  DocumentDetail,
  DocumentDownload,
  FolderContent,
  FolderPage,
  UploadStarted,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { subscribeToFeatures } from "../../testing/billing.ts";
import {
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltClub,
  type BuiltFamily,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

loadEnvFiles();
const S3 = {
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  // Uploads and downloads go straight to the local storage in tests.
  S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION ?? "garage",
  S3_BUCKET_FILES: process.env.S3_BUCKET_FILES ?? "clubadmin-files",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
};
const storageConfig = objectStorageConfig(S3);
if (!storageConfig) throw new Error("S3_* must be set (pnpm dev:services)");
const storage = new ObjectStorage(storageConfig);

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function api(personId: string, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId)}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let manager: BuiltPerson;
let teamId: string;
let otherTeamId: string;
let coach: BuiltPerson;
let otherCoach: BuiltPerson;
let chair: BuiltPerson;
let member: BuiltPerson;
let family: BuiltFamily;
let outsider: BuiltPerson;

const base = () => `/clubs/${club.id}`;
const PDF = Buffer.from("%PDF-1.4\nseason schedule\n%%EOF\n");

/** Upload a file through its link and confirm it. */
async function upload(personId: string, started: UploadStarted, data: Buffer): Promise<void> {
  const put = await fetch(started.uploadUrl, {
    method: "PUT",
    headers: started.headers,
    body: new Uint8Array(data),
  });
  expect(put.status).toBe(200);
  const done = await api(
    personId,
    "POST",
    `${base()}/documents/${started.documentId}/versions/${started.versionId}/uploaded`,
  );
  expect(done.statusCode).toBe(204);
}

/** The worker's verdict, simulated: the version is clean and becomes current. */
async function markClean(versionId: string): Promise<void> {
  await t.db.withSystem("test:scan", { clubId: club.id }, async (tx) => {
    await tx.execute(sql`
      UPDATE public.document_versions SET status = 'clean', scanned_at = now()
      WHERE id = ${versionId}::uuid`);
    await tx.execute(sql`
      UPDATE public.documents d SET current_version_id = ${versionId}
      FROM public.document_versions v WHERE v.id = ${versionId}::uuid AND d.id = v.document_id`);
  });
}

async function roleId(scope: "club" | "group", key: string): Promise<string> {
  const { rows } = await t.db.withSystem("test:roles", { clubId: club.id }, (tx) =>
    tx.execute<{ id: string }>(sql`
      SELECT id FROM public.roles
      WHERE club_id = ${club.id}::uuid AND scope = ${scope} AND template_key = ${key}`),
  );
  return rows[0]!.id;
}

async function newFile(personId: string, folderId: string, fileName: string, data = PDF) {
  const res = await api(personId, "POST", `${base()}/folders/${folderId}/uploads`, {
    fileName,
    size: data.length,
  });
  expect(res.statusCode).toBe(201);
  const started = res.json<UploadStarted>();
  await upload(personId, started, data);
  return started;
}

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db, { storage });
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    DOCUMENTS_CLUB_LIMIT_MB: "1",
    ...S3,
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  manager = club.manager;
  await subscribeToFeatures(t, [club.id], ["documents"]);
  teamId = (await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" })).id;
  otherTeamId = (await s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" })).id;
  coach = await buildPerson(s);
  otherCoach = await buildPerson(s);
  chair = await buildPerson(s);
  member = await buildPerson(s);
  outsider = await buildPerson(s);
  family = await buildFamily(s, { club, childBirthDate: "2015-04-01" });
  for (const p of [coach, otherCoach, chair, member]) await s.memberships.addMember(club.ctx, p.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, otherTeamId, otherCoach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, teamId, family.child.id, "member");
  await s.roles.assignRole(club.ctx, chair.id, "chair");
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("a group's folder", () => {
  let folderId: string;
  let schedule: UploadStarted;

  it("is created by the head coach for the group; its players' guardians read it", async () => {
    const created = await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, {
      name: "Matchschema",
    });
    expect(created.statusCode).toBe(201);
    folderId = created.json<{ id: string }>().id;

    const forGuardian = (
      await api(family.guardian.id, "GET", `${base()}/groups/${teamId}/folders`)
    ).json<FolderPage>();
    expect(forGuardian.items.map((f) => f.name)).toEqual(["Matchschema"]);
    expect(forGuardian.canManage).toBe(false);
    const content = (
      await api(family.guardian.id, "GET", `${base()}/folders/${folderId}`)
    ).json<FolderContent>();
    expect(content.audience).toEqual([
      { kind: "group", groupId: teamId, groupName: "F2015", roleIds: [] },
    ]);

    // A member outside the group neither lists nor opens it; another club's person gets 404.
    const forMember = (
      await api(member.id, "GET", `${base()}/groups/${teamId}/folders`)
    ).json<FolderPage>();
    expect(forMember.items).toEqual([]);
    expect((await api(member.id, "GET", `${base()}/folders/${folderId}`)).statusCode).toBe(404);
    expect((await api(outsider.id, "GET", `${base()}/folders/${folderId}`)).statusCode).toBe(404);
    // Another team's coach does not manage it.
    expect(
      (await api(otherCoach.id, "POST", `${base()}/folders/${folderId}/folders`, { name: "X" }))
        .statusCode,
    ).toBe(404);
  });

  it("refuses a duplicate name and file types off the allow list", async () => {
    const twice = await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, {
      name: "matchschema",
    });
    expect(twice.statusCode).toBe(409);
    expect(detail(twice)).toBe("folder_name_taken");
    const exe = await api(coach.id, "POST", `${base()}/folders/${folderId}/uploads`, {
      fileName: "schema.exe",
      size: 10,
    });
    expect(exe.statusCode).toBe(415);
    expect(detail(exe)).toBe("document_type_not_allowed");
  });

  it("shows an upload only after a clean scan; the uploader's leaders see it pending", async () => {
    schedule = await newFile(coach.id, folderId, "Vårens matcher.pdf");
    const forCoach = (
      await api(coach.id, "GET", `${base()}/folders/${folderId}`)
    ).json<FolderContent>();
    expect(forCoach.documents).toHaveLength(1);
    expect(forCoach.documents[0]!.current).toBeNull();
    expect(forCoach.documents[0]!.latest?.status).toBe("pending");
    expect(forCoach.documents[0]!.latest?.uploadedBy?.id).toBe(coach.id);
    const before = (
      await api(family.guardian.id, "GET", `${base()}/folders/${folderId}`)
    ).json<FolderContent>();
    expect(before.documents).toEqual([]);
    expect(
      (await api(family.guardian.id, "GET", `${base()}/documents/${schedule.documentId}`))
        .statusCode,
    ).toBe(404);
    const early = await api(coach.id, "GET", `${base()}/documents/${schedule.documentId}/download`);
    expect(early.statusCode).toBe(409);

    await markClean(schedule.versionId);
    const after = (
      await api(family.guardian.id, "GET", `${base()}/folders/${folderId}`)
    ).json<FolderContent>();
    expect(after.documents.map((d) => d.name)).toEqual(["Vårens matcher.pdf"]);
    expect(after.documents[0]!.latest).toBeNull();
  });

  it("downloads as an attachment from the storage; narrow audiences are audited", async () => {
    const res = await api(
      family.guardian.id,
      "GET",
      `${base()}/documents/${schedule.documentId}/download`,
    );
    expect(res.statusCode).toBe(200);
    const link = res.json<DocumentDownload>();
    const file = await fetch(link.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(file.headers.get("content-disposition")).toContain("attachment;");
    expect(file.headers.get("content-disposition")).toContain("filename*=UTF-8''V%C3%A5rens");
    expect(await auditActionsOf(t, schedule.documentId)).toContain("document.downloaded");
  });

  it("keeps every version; members see the clean ones", async () => {
    const res = await api(coach.id, "POST", `${base()}/documents/${schedule.documentId}/versions`, {
      fileName: "Vårens matcher v2.pdf",
      size: PDF.length,
    });
    expect(res.statusCode).toBe(201);
    const v2 = res.json<UploadStarted>();
    expect(v2.documentId).toBe(schedule.documentId);
    await upload(coach.id, v2, PDF);
    const pending = (
      await api(family.guardian.id, "GET", `${base()}/documents/${schedule.documentId}`)
    ).json<DocumentDetail>();
    expect(pending.versions.map((v) => v.number)).toEqual([1]);
    await markClean(v2.versionId);
    const both = (
      await api(family.guardian.id, "GET", `${base()}/documents/${schedule.documentId}`)
    ).json<DocumentDetail>();
    expect(both.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(both.document.current?.number).toBe(2);
    const old = await api(
      family.guardian.id,
      "GET",
      `${base()}/documents/${schedule.documentId}/versions/${schedule.versionId}/download`,
    );
    expect(old.statusCode).toBe(200);
  });

  it("moves files only within the group, and only to folders the caller manages", async () => {
    const other = (
      await api(otherCoach.id, "POST", `${base()}/groups/${otherTeamId}/folders`, {
        name: "Övrigt",
      })
    ).json<{ id: string }>().id;
    const notMine = await api(coach.id, "PATCH", `${base()}/documents/${schedule.documentId}`, {
      folderId: other,
    });
    expect(notMine.statusCode).toBe(403);
    const byManager = await api(manager.id, "PATCH", `${base()}/documents/${schedule.documentId}`, {
      folderId: other,
    });
    expect(byManager.statusCode).toBe(409);
    expect(detail(byManager)).toBe("document_move_scope");
    const sub = (
      await api(coach.id, "POST", `${base()}/folders/${folderId}/folders`, { name: "Cuper" })
    ).json<{ id: string }>().id;
    const moved = await api(coach.id, "PATCH", `${base()}/documents/${schedule.documentId}`, {
      folderId: sub,
      name: "Vårens matcher",
    });
    expect(moved.statusCode).toBe(204);
    // The subfolder inherits the group's audience: the guardian still reads the file.
    const inSub = (
      await api(family.guardian.id, "GET", `${base()}/folders/${sub}`)
    ).json<FolderContent>();
    expect(inSub.documents.map((d) => d.name)).toEqual(["Vårens matcher"]);
    expect(inSub.path.map((p) => p.name)).toEqual(["Matchschema", "Cuper"]);
  });

  it("deletes a folder with content only after a confirmation", async () => {
    const refused = await api(coach.id, "DELETE", `${base()}/folders/${folderId}`);
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toBe("folder_not_empty");
    const deleted = await api(coach.id, "DELETE", `${base()}/folders/${folderId}?confirm=true`);
    expect(deleted.statusCode).toBe(204);
    expect((await api(coach.id, "GET", `${base()}/folders/${folderId}`)).statusCode).toBe(404);
    expect(
      (await api(coach.id, "GET", `${base()}/documents/${schedule.documentId}`)).statusCode,
    ).toBe(404);
    const { rows } = await t.db.withSystem("test:outbox", {}, (tx) =>
      tx.execute<{ payload: { documentIds: string[] } }>(sql`
        SELECT payload FROM outbox.events WHERE type = 'documents.deleted'`),
    );
    expect(rows.flatMap((r) => r.payload.documentIds)).toContain(schedule.documentId);
    expect(await auditActionsOf(t, folderId)).toContain("document.folder.deleted");
  });
});

describe("the club's folders and audiences", () => {
  it("are managed by the club manager; a club-wide folder is read by members and guardians", async () => {
    const coachTry = await api(coach.id, "POST", `${base()}/folders`, { name: "Policyer" });
    expect(coachTry.statusCode).toBe(403);
    const created = await api(manager.id, "POST", `${base()}/folders`, { name: "Policyer" });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const file = await newFile(manager.id, id, "Trafikpolicy.pdf");
    await markClean(file.versionId);
    for (const reader of [member, family.guardian, coach]) {
      const page = (await api(reader.id, "GET", `${base()}/folders`)).json<FolderPage>();
      expect(page.items.map((f) => f.name)).toContain("Policyer");
    }
    // Not audited: the whole club reads it.
    await api(member.id, "GET", `${base()}/documents/${file.documentId}/download`);
    expect(await auditActionsOf(t, file.documentId)).not.toContain("document.downloaded");
  });

  it("limits a folder to a club role, or to some roles of a group", async () => {
    const board = (
      await api(manager.id, "POST", `${base()}/folders`, {
        name: "Styrelsen",
        audience: [{ kind: "club_role", roleId: await roleId("club", "chair") }],
      })
    ).json<{ id: string }>().id;
    expect((await api(chair.id, "GET", `${base()}/folders/${board}`)).statusCode).toBe(200);
    expect((await api(member.id, "GET", `${base()}/folders/${board}`)).statusCode).toBe(404);

    const leaders = (
      await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, {
        name: "Ledare",
        audience: [
          { kind: "group_roles", groupId: teamId, roleIds: [await roleId("group", "head_coach")] },
        ],
      })
    ).json<{ id: string }>().id;
    expect((await api(coach.id, "GET", `${base()}/folders/${leaders}`)).statusCode).toBe(200);
    expect((await api(family.guardian.id, "GET", `${base()}/folders/${leaders}`)).statusCode).toBe(
      404,
    );

    // A file of that folder made readable by the whole group (a wider audience).
    const file = await newFile(coach.id, leaders, "Laguttagning.pdf");
    await markClean(file.versionId);
    const widened = await api(coach.id, "PATCH", `${base()}/documents/${file.documentId}`, {
      audience: [{ kind: "group", groupId: teamId }],
    });
    expect(widened.statusCode).toBe(204);
    expect(
      (await api(family.guardian.id, "GET", `${base()}/documents/${file.documentId}`)).statusCode,
    ).toBe(200);

    // Groups and roles of another club are refused.
    const other = await buildClub(s);
    const otherGroup = (await s.groups.createGroup(other.ctx, { name: "X", kind: "team" })).id;
    const invalid = await api(manager.id, "POST", `${base()}/folders`, {
      name: "Fel",
      audience: [{ kind: "group", groupId: otherGroup }],
    });
    expect(invalid.statusCode).toBe(400);
    expect(detail(invalid)).toBe("audience_invalid");
  });

  it("refuses an upload over the club's storage limit", async () => {
    const id = (await api(manager.id, "POST", `${base()}/folders`, { name: "Stort" })).json<{
      id: string;
    }>().id;
    const res = await api(manager.id, "POST", `${base()}/folders/${id}/uploads`, {
      fileName: "film.pdf",
      size: 1024 * 1024,
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toBe("storage_limit_exceeded");
  });
});
