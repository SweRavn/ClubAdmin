// SPDX-License-Identifier: AGPL-3.0-only
// The file archive, part B (P2.2, ADR 0049 decisions 4b, 6, 8, 9), through
// the API against the local object storage: documents attached to notices
// (readable by the invitees while attached, uploaded into the notices
// folder), "Mina dokument" with what is new, the club's own storage limits,
// deletion dates and public documents.

import { sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { ObjectStorage, objectStorageConfig } from "@clubadmin/server-kit/object-storage";
import type {
  DocumentDetail,
  MyDocumentPage,
  NoticeAttachmentList,
  PublicDocumentList,
  Storage,
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

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function api(personId: string | null, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: personId ? { authorization: `Bearer ${await devToken(personId)}` } : {},
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let manager: BuiltPerson;
let teamId: string;
let coach: BuiltPerson;
let chair: BuiltPerson;
let family: BuiltFamily;
let outsiderFamily: BuiltFamily;
let activityId: string;
let eventId: string;
let boardFile: string;

const base = () => `/clubs/${club.id}`;
const PDF = Buffer.from("%PDF-1.4\ncup information\n%%EOF\n");
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function upload(personId: string, started: UploadStarted): Promise<void> {
  const put = await fetch(started.uploadUrl, {
    method: "PUT",
    headers: started.headers,
    body: new Uint8Array(PDF),
  });
  expect(put.status).toBe(200);
  const done = await api(
    personId,
    "POST",
    `${base()}/documents/${started.documentId}/versions/${started.versionId}/uploaded`,
  );
  expect(done.statusCode).toBe(204);
}

/** The worker's verdict, simulated: clean, current and published. */
async function markClean(versionId: string): Promise<void> {
  await t.db.withSystem("test:scan", { clubId: club.id }, async (tx) => {
    await tx.execute(sql`
      UPDATE public.document_versions SET status = 'clean', scanned_at = now()
      WHERE id = ${versionId}::uuid`);
    await tx.execute(sql`
      UPDATE public.documents d SET current_version_id = ${versionId}, published_at = now()
      FROM public.document_versions v WHERE v.id = ${versionId}::uuid AND d.id = v.document_id`);
  });
}

async function roleId(key: string): Promise<string> {
  const { rows } = await t.db.withSystem("test:roles", { clubId: club.id }, (tx) =>
    tx.execute<{ id: string }>(sql`
      SELECT id FROM public.roles
      WHERE club_id = ${club.id}::uuid AND scope = 'club' AND template_key = ${key}`),
  );
  return rows[0]!.id;
}

async function newFile(personId: string, folderId: string, fileName: string, notify = false) {
  const res = await api(personId, "POST", `${base()}/folders/${folderId}/uploads`, {
    fileName,
    size: PDF.length,
    ...(notify ? { notify } : {}),
  });
  expect(res.statusCode).toBe(201);
  const started = res.json<UploadStarted>();
  await upload(personId, started);
  await markClean(started.versionId);
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
  coach = await buildPerson(s);
  chair = await buildPerson(s);
  family = await buildFamily(s, { club, childBirthDate: "2015-04-01" });
  outsiderFamily = await buildFamily(s, { club, childBirthDate: "2014-04-01" });
  for (const p of [coach, chair]) await s.memberships.addMember(club.ctx, p.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, teamId, family.child.id, "member");
  await s.roles.assignRole(club.ctx, chair.id, "chair");
  const start = new Date(Date.now() + 5 * 86_400_000);
  activityId = (
    await s.activities.createActivity(club.ctx, teamId, {
      kind: "match",
      title: "Cup",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    })
  ).activity.id;
  eventId = (
    await s.events.createEvent(club.ctx, {
      title: "Camp",
      audience: "groups",
      groupIds: [teamId],
      startsAt: `${day(20)}T09:00:00Z`,
      endsAt: `${day(20)}T16:00:00Z`,
      registrationClosesAt: `${day(19)}T20:00:00Z`,
      publish: true,
    })
  ).event.id;
  // The board's folder: only the chair reads it.
  const board = (
    await api(manager.id, "POST", `${base()}/folders`, {
      name: "Styrelsen",
      audience: [{ kind: "club_role", roleId: await roleId("chair") }],
    })
  ).json<{ id: string }>().id;
  boardFile = (await newFile(manager.id, board, "Cupens regler.pdf")).documentId;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("documents attached to notices", () => {
  it("are read by the activity's invitees while attached, and only then", async () => {
    // The guardian of a player cannot read the board's file.
    const guardian = family.guardian.id;
    expect((await api(guardian, "GET", `${base()}/documents/${boardFile}`)).statusCode).toBe(404);
    // The coach does not read it either, so may not attach it.
    const refused = await api(coach.id, "PUT", `/activities/${activityId}/attachments`, {
      documentIds: [boardFile],
    });
    expect(refused.statusCode).toBe(404);
    // The club manager (who manages the archive and the team's activities) attaches it.
    const set = await api(manager.id, "PUT", `/activities/${activityId}/attachments`, {
      documentIds: [boardFile],
    });
    expect(set.statusCode).toBe(200);
    const list = set.json<NoticeAttachmentList>();
    expect(list.items.map((a) => a.document.name)).toEqual(["Cupens regler.pdf"]);
    expect(list.shownTo).toEqual({
      club: false,
      groups: [{ id: teamId, name: "F2015" }],
      calledUp: null,
    });
    expect(await auditActionsOf(t, boardFile)).toContain("document.notice.added");

    // Now the player's guardian reads and downloads it; another family does not.
    const forGuardian = (
      await api(guardian, "GET", `/activities/${activityId}/attachments`)
    ).json<NoticeAttachmentList>();
    expect(forGuardian.items).toHaveLength(1);
    expect(forGuardian.shownTo).toBeNull();
    expect((await api(guardian, "GET", `${base()}/documents/${boardFile}`)).statusCode).toBe(200);
    expect(
      (await api(guardian, "GET", `${base()}/documents/${boardFile}/download`)).statusCode,
    ).toBe(200);
    expect(
      (await api(outsiderFamily.guardian.id, "GET", `${base()}/documents/${boardFile}`)).statusCode,
    ).toBe(404);

    // Detached: no longer readable, and not deleted.
    await api(manager.id, "PUT", `/activities/${activityId}/attachments`, { documentIds: [] });
    expect((await api(guardian, "GET", `${base()}/documents/${boardFile}`)).statusCode).toBe(404);
    expect((await api(chair.id, "GET", `${base()}/documents/${boardFile}`)).statusCode).toBe(200);
  });

  it("stores an upload in the team's notices folder and attaches it", async () => {
    const res = await api(coach.id, "POST", `/events/${eventId}/attachments/uploads`, {
      fileName: "Packlista.pdf",
      size: PDF.length,
    });
    expect(res.statusCode).toBe(201);
    const started = res.json<UploadStarted>();
    await upload(coach.id, started);
    // Not visible to invitees before the scan; the coach sees it pending.
    const pending = (
      await api(family.guardian.id, "GET", `/events/${eventId}/attachments`)
    ).json<NoticeAttachmentList>();
    expect(pending.items).toEqual([]);
    const forCoach = (
      await api(coach.id, "GET", `/events/${eventId}/attachments`)
    ).json<NoticeAttachmentList>();
    expect(forCoach.items[0]?.document.latest?.status).toBe("pending");
    await markClean(started.versionId);
    const after = (
      await api(family.guardian.id, "GET", `/events/${eventId}/attachments`)
    ).json<NoticeAttachmentList>();
    expect(after.items.map((a) => a.document.name)).toEqual(["Packlista.pdf"]);
    const file = (
      await api(coach.id, "GET", `${base()}/documents/${started.documentId}`)
    ).json<DocumentDetail>();
    expect(file.path.map((p) => p.name)).toEqual(["Kallelser"]);
    // A second upload goes to the same folder.
    const again = await api(coach.id, "POST", `/events/${eventId}/attachments/uploads`, {
      fileName: "Karta.pdf",
      size: PDF.length,
    });
    const second = (
      await api(coach.id, "GET", `${base()}/documents/${again.json<UploadStarted>().documentId}`)
    ).json<DocumentDetail>();
    expect(second.path).toEqual(file.path);
  });
});

describe("Mina dokument", () => {
  it("lists the newest files of one's groups and clubs and marks what is new", async () => {
    const folder = (
      await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, { name: "Matchschema" })
    ).json<{ id: string }>().id;
    const schedule = await newFile(coach.id, folder, "Vår.pdf");
    const page = (await api(family.guardian.id, "GET", "/me/documents")).json<MyDocumentPage>();
    const item = page.items.find((i) => i.document.id === schedule.documentId);
    expect(item).toMatchObject({ groupName: "F2015", isNew: true, clubName: club.name });
    // The board's file is not listed for the guardian; the chair sees it.
    expect(page.items.map((i) => i.document.id)).not.toContain(boardFile);
    const forChair = (await api(chair.id, "GET", "/me/documents")).json<MyDocumentPage>();
    expect(forChair.items.map((i) => i.document.id)).toContain(boardFile);

    const seen = await api(family.guardian.id, "POST", `${base()}/documents/seen`, {
      groupId: teamId,
    });
    expect(seen.statusCode).toBe(204);
    const later = (await api(family.guardian.id, "GET", "/me/documents")).json<MyDocumentPage>();
    expect(later.items.find((i) => i.document.id === schedule.documentId)?.isNew).toBe(false);

    // Keyset: one at a time, the second page continues after the first.
    const first = (
      await api(family.guardian.id, "GET", "/me/documents?limit=1")
    ).json<MyDocumentPage>();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const next = (
      await api(family.guardian.id, "GET", `/me/documents?limit=1&cursor=${first.nextCursor}`)
    ).json<MyDocumentPage>();
    expect(next.items[0]?.document.id).not.toBe(first.items[0]?.document.id);
  });
});

describe("the club's storage limits", () => {
  it("are set by the club within the operator's, and per group within the club's", async () => {
    const before = (await api(manager.id, "GET", `${base()}/storage`)).json<Storage>();
    expect(before.operatorLimitBytes).toBe(1024 * 1024);
    expect(before.usedBytes).toBeGreaterThan(0);
    expect(before.groups.map((g) => g.groupName)).toContain("F2015");
    expect((await api(coach.id, "GET", `${base()}/storage`)).statusCode).toBe(403);

    const tooBig = await api(manager.id, "PUT", `${base()}/storage`, {
      clubLimitBytes: 2 * 1024 * 1024,
      groups: [],
    });
    expect(tooBig.statusCode).toBe(400);
    expect(detail(tooBig)).toBe("storage_limit_invalid");
    const set = await api(manager.id, "PUT", `${base()}/storage`, {
      clubLimitBytes: 512 * 1024,
      groups: [{ groupId: teamId, limitBytes: 1024 }],
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<Storage>()).toMatchObject({
      limitBytes: 512 * 1024,
      clubLimitBytes: 512 * 1024,
    });

    // The team is over its limit now: its uploads are refused.
    const folder = (
      await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, { name: "Övrigt" })
    ).json<{ id: string }>().id;
    const refused = await api(coach.id, "POST", `${base()}/folders/${folder}/uploads`, {
      fileName: "x.pdf",
      size: 2000,
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toBe("storage_limit_group_exceeded");
    await api(manager.id, "PUT", `${base()}/storage`, {
      clubLimitBytes: null,
      groups: [{ groupId: teamId, limitBytes: null }],
    });
  });
});

describe("deletion dates", () => {
  it("are a day after today and shown on the file", async () => {
    const folder = (
      await api(coach.id, "POST", `${base()}/groups/${teamId}/folders`, { name: "Cupen" })
    ).json<{ id: string }>().id;
    const file = await newFile(coach.id, folder, "Cupinfo.pdf");
    const past = await api(coach.id, "PATCH", `${base()}/documents/${file.documentId}`, {
      deleteAfter: day(0),
    });
    expect(past.statusCode).toBe(400);
    expect(detail(past)).toBe("delete_after_past");
    const ok = await api(coach.id, "PATCH", `${base()}/documents/${file.documentId}`, {
      deleteAfter: day(30),
    });
    expect(ok.statusCode).toBe(204);
    const shown = (
      await api(coach.id, "GET", `${base()}/documents/${file.documentId}`)
    ).json<DocumentDetail>();
    expect(shown.document.deleteAfter).toBe(day(30));
  });
});

describe("public documents", () => {
  it("are listed and downloaded by the club's slug without login", async () => {
    const folder = (
      await api(manager.id, "POST", `${base()}/folders`, {
        name: "Offentligt",
        audience: [{ kind: "public" }],
      })
    ).json<{ id: string }>().id;
    const sub = (
      await api(manager.id, "POST", `${base()}/folders/${folder}/folders`, { name: "Policyer" })
    ).json<{ id: string }>().id;
    const file = await newFile(manager.id, sub, "Trafikpolicy.pdf");
    const list = await api(null, "GET", `/public/clubs/${club.slug}/documents`);
    expect(list.statusCode).toBe(200);
    expect(list.json<PublicDocumentList>().items.map((d) => d.name)).toEqual(["Trafikpolicy.pdf"]);
    const link = await api(
      null,
      "GET",
      `/public/clubs/${club.slug}/documents/${file.documentId}/download`,
    );
    expect(link.statusCode).toBe(200);
    expect(
      (await api(null, "GET", `/public/clubs/${club.slug}/documents/${boardFile}/download`))
        .statusCode,
    ).toBe(404);
    expect((await api(null, "GET", "/public/clubs/no-such-club/documents")).statusCode).toBe(404);
  });
});
