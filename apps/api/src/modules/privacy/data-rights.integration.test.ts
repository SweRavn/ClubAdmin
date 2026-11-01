// SPDX-License-Identifier: AGPL-3.0-only
// "Download my data", account deletion and ward erasure (P1.8b), through the
// services and the jobs against the database and the local object storage.

import { createDatabase, type Database } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { ObjectStorage, objectStorageConfig } from "@clubadmin/server-kit/object-storage";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import {
  AuthorizationCache,
  AuthorizationService,
  PersonPresenter,
  PersonVisibility,
} from "../authorization/index.ts";
import { type DataExportJobDeps, runDataExport } from "./data-export.job.ts";
import { type ErasureJobDeps, runDueErasures } from "./erasure.job.ts";
import type { OutstandingObligationsProvider } from "./outstanding-obligations.ts";

loadEnvFiles();
const storageConfig = objectStorageConfig({
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION ?? "garage",
  S3_BUCKET_FILES: process.env.S3_BUCKET_FILES ?? "clubadmin-files",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
});
if (!storageConfig) throw new Error("S3_* must be set (pnpm dev:services)");
const storage = new ObjectStorage(storageConfig);

let t: TestDatabase;
let s: CoreServices;
let retention: Database;
let exportDeps: DataExportJobDeps;
let erasureDeps: ErasureJobDeps;
const owing = new Set<string>();
const obligations: OutstandingObligationsProvider[] = [
  {
    forPerson: (_tx, _clubId, personId) =>
      Promise.resolve(owing.has(personId) ? { count: 2, contactRole: "treasurer" } : null),
  },
];
const revoked: string[] = [];
const deletedUsers: string[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  retention = createDatabase({ url: t.url("retention"), max: 1 });
  s = createCoreServices(t.db, { obligations, storage });
  const cache = new AuthorizationCache(undefined);
  exportDeps = {
    db: t.db,
    retentionDb: retention,
    storage,
    people: s.people,
    events: s.events,
    presenter: new PersonPresenter(new PersonVisibility(t.db, cache)),
    authorization: new AuthorizationService(t.db, cache),
  };
  erasureDeps = {
    db: t.db,
    retentionDb: retention,
    storage,
    leaving: s.leaving,
    guardianships: s.guardianships,
    obligations,
    sessions: {
      revokeAllOf: (personId) => {
        revoked.push(personId);
        return Promise.resolve(1);
      },
    },
    zitadelUsers: {
      delete: (userId) => {
        deletedUsers.push(userId);
        return Promise.resolve();
      },
    },
  };
});
afterAll(async () => {
  await retention?.close();
  await t?.drop();
});

const isError = (code: string) => (e: unknown) => isDomainError(e, code as never);

async function readZip(key: string): Promise<Record<string, string>> {
  const file = await storage.getObject(key, { maxBytes: 20 * 1024 * 1024 });
  const entries = unzipSync(new Uint8Array(file!));
  return Object.fromEntries(
    Object.entries(entries).map(([name, data]) => [name, new TextDecoder().decode(data)]),
  );
}

/** Moves a scheduled erasure's date to the past, as if the grace period had run out. */
async function graceOver(personId: string) {
  await t.query(
    "admin",
    "UPDATE erasure_requests SET scheduled_for = now() - interval '1 minute' WHERE person_id = $1 AND status = 'scheduled'",
    [personId],
  );
}

describe("download my data", () => {
  it("writes a ZIP for a parent and for the child, readable only by the requester", async () => {
    const club = await buildClub(s);
    const family = await buildFamily(s, { club });
    await s.memberships.addMember(club.ctx, family.guardian.id);
    const parent = actor(family.guardian.id);
    await s.consents.give(
      actor(family.guardian.id, club.id),
      "guardian",
      family.child.id,
      "photo_publication",
      { textVersion: "default:1" },
    );

    const own = await s.dataExports.request(parent, family.guardian.id, "sv");
    const child = await s.dataExports.request(parent, family.child.id, "sv");
    expect(own.status).toBe("queued");
    // The insert queued the job.
    const { rows: jobs } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'privacy:export'",
    );
    expect(jobs[0]!.n).toBeGreaterThanOrEqual(2);

    expect(await runDataExport(exportDeps, own.id)).toBe("ready");
    expect(await runDataExport(exportDeps, child.id)).toBe("ready");
    // Run again: nothing to do.
    expect(await runDataExport(exportDeps, own.id)).toBeNull();

    const [listed] = await s.dataExports.list(parent, { after: null, limit: 10 });
    expect(listed!.status).toBe("ready");
    expect(listed!.objectKey).toMatch(/^data-exports\/[0-9a-f-]+\.zip$/);

    const files = await readZip(listed!.objectKey!);
    expect(Object.keys(files).sort()).toEqual(["data.json", "index.html"]);
    const data = JSON.parse(files["data.json"]!) as {
      schemaVersion: number;
      subjectPersonId: string;
      parts: { controller: string; clubName?: string; sections: Record<string, unknown[]> }[];
      people: Record<string, { name: string }>;
    };
    expect(data.schemaVersion).toBe(1);
    expect(data.subjectPersonId).toBe(family.child.id);
    const clubPart = data.parts.find((p) => p.controller === "club")!;
    expect(clubPart.clubName).toBe(club.name);
    expect(clubPart.sections.consents).toHaveLength(1);
    expect(clubPart.sections.memberships).toHaveLength(1);
    // The parent who gave the consent is named; IDs elsewhere.
    expect(data.people[family.guardian.id]?.name).toContain(family.guardian.givenName);
    expect(files["index.html"]).toContain("<!doctype html>");
    expect(files["index.html"]).not.toMatch(/<script|https?:\/\//);

    // Only the requester downloads, with a link.
    const link = await s.dataExports.download(parent, own.id);
    expect(link.url).toContain("X-Amz-Signature");
    await expect(s.dataExports.download(actor(family.coGuardian.id), own.id)).rejects.toSatisfy(
      isError("not_found"),
    );
    expect(await auditActionsOf(t, own.id)).toEqual([
      "privacy.export.requested",
      "privacy.export.downloaded",
    ]);

    // After seven days the file is gone.
    await t.query("admin", "UPDATE data_exports SET expires_at = now() WHERE id = $1", [own.id]);
    await expect(s.dataExports.download(parent, own.id)).rejects.toSatisfy(
      isError("export_expired"),
    );
  });

  it("allows three requests a day", async () => {
    const p = await buildPerson(s);
    for (let i = 0; i < 3; i++) await s.dataExports.request(actor(p.id), p.id, "en");
    await expect(s.dataExports.request(actor(p.id), p.id, "en")).rejects.toSatisfy(
      isError("export_limit_reached"),
    );
  });
});

describe("account deletion", () => {
  it("is refused while roles, ownerships or invoices remain, each named with the club", async () => {
    const club = await buildClub(s);
    const coach = await buildPerson(s);
    await s.memberships.addMember(club.ctx, coach.id);
    const group = await s.groups.createGroup(club.ctx, { name: "F2016", kind: "team" });
    await s.groups.addOwner(club.ctx, group.id, coach.id, "club_manager");

    const preview = await s.erasure.deletionPreview(actor(coach.id));
    expect(preview.blockers).toEqual([
      expect.objectContaining({
        clubId: club.id,
        code: "roles_must_be_removed",
        assignments: [expect.objectContaining({ kind: "group_owner", groupName: "F2016" })],
      }),
    ]);
    await expect(s.erasure.scheduleDeletion(actor(coach.id), [])).rejects.toSatisfy(
      isError("erasure_blocked"),
    );

    // The last club manager hands over first.
    const managerPreview = await s.erasure.deletionPreview(actor(club.manager.id));
    expect(managerPreview.blockers.map((b) => b.code)).toContain("last_club_manager");

    const owes = await buildPerson(s);
    await s.memberships.addMember(club.ctx, owes.id);
    owing.add(owes.id);
    const owed = await s.erasure.deletionPreview(actor(owes.id));
    expect(owed.blockers).toEqual([
      expect.objectContaining({ code: "outstanding_invoices", count: 2, contactRole: "treasurer" }),
    ]);
    owing.delete(owes.id);
  });

  it("runs after the grace period: leaves the clubs, ends guardianships, erases, revokes, deletes the login", async () => {
    const club = await buildClub(s);
    const family = await buildFamily(s, { club });
    await s.memberships.addMember(club.ctx, family.guardian.id);
    // A child without a login whose only guardian with a login is the guardian.
    const { child: solo } = await s.guardianships.addChild(actor(family.guardian.id), {
      givenName: "Solo",
      familyName: "Barn",
      birthDate: "2018-05-05",
    });
    await t.query(
      "admin",
      "UPDATE accounts SET idp_subject = 'zitadel-user-1' WHERE person_id = $1",
      [family.guardian.id],
    );
    const me = actor(family.guardian.id);
    const preview = await s.erasure.deletionPreview(me);
    // Elsa has a second guardian with a login; Solo has only this one.
    expect(preview.wards.map((w) => w.personId)).toEqual([solo.id]);

    const request = await s.erasure.scheduleDeletion(me, [solo.id]);
    expect(request.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    await expect(s.erasure.scheduleDeletion(me, [])).rejects.toSatisfy(isError("erasure_pending"));
    expect((await s.erasure.pendingDeletion(me))?.scheduledFor).toEqual(request.scheduledFor);

    // Cancelled and scheduled again.
    await s.erasure.cancelDeletion(me);
    expect(await s.erasure.pendingDeletion(me)).toBeNull();
    await s.erasure.scheduleDeletion(me, [solo.id]);

    // Not yet due: nothing happens.
    expect(await runDueErasures(erasureDeps)).toBe(0);
    await graceOver(family.guardian.id);
    expect(await runDueErasures(erasureDeps)).toBe(1);

    const { rows: person } = await t.query<{ given_name: string; anonymized_at: Date | null }>(
      "admin",
      "SELECT given_name, anonymized_at FROM people WHERE id = ANY($1) ORDER BY id",
      [[family.guardian.id, solo.id]],
    );
    expect(person.every((p) => p.given_name === "" && p.anonymized_at !== null)).toBe(true);
    const { rows: memberships } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM club_memberships WHERE person_id = $1 AND valid_to IS NULL",
      [family.guardian.id],
    );
    expect(memberships[0]!.n).toBe(0);
    const { rows: guardianships } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM guardianships WHERE guardian_person_id = $1 AND valid_to IS NULL",
      [family.guardian.id],
    );
    expect(guardianships[0]!.n).toBe(0);
    const { rows: ledger } = await t.query<{ reason: string }>(
      "admin",
      "SELECT reason FROM privacy.deletion_ledger WHERE person_id = ANY($1) ORDER BY reason",
      [[family.guardian.id, solo.id]],
    );
    expect(ledger.map((l) => l.reason)).toEqual(["account_deleted", "ward_erased"]);
    expect(revoked).toContain(family.guardian.id);
    expect(deletedUsers).toEqual(["zitadel-user-1"]);
    const { rows: done } = await t.query<{ status: string; pending_idp_subject: string | null }>(
      "admin",
      "SELECT status, pending_idp_subject FROM erasure_requests WHERE person_id = $1 AND status <> 'cancelled'",
      [family.guardian.id],
    );
    expect(done).toEqual([{ status: "done", pending_idp_subject: null }]);
    const { rows: unerased } = await t.query("admin", "SELECT * FROM privacy.unerased_people()");
    expect(unerased).toEqual([]);

    // Running again changes nothing.
    expect(await runDueErasures(erasureDeps)).toBe(0);
  });

  it("stops when a role was given during the grace period", async () => {
    const club = await buildClub(s);
    const p = await buildPerson(s);
    await s.memberships.addMember(club.ctx, p.id);
    await s.erasure.scheduleDeletion(actor(p.id), []);
    await s.roles.assignRole(club.ctx, p.id, "registrar");
    await graceOver(p.id);
    await runDueErasures(erasureDeps);
    const { rows } = await t.query<{ status: string; error_code: string }>(
      "admin",
      "SELECT status, error_code FROM erasure_requests WHERE person_id = $1",
      [p.id],
    );
    expect(rows).toEqual([{ status: "failed", error_code: "blocked" }]);
    const { rows: people } = await t.query<{ given_name: string }>(
      "admin",
      "SELECT given_name FROM people WHERE id = $1",
      [p.id],
    );
    expect(people[0]!.given_name).not.toBe("");
  });
});

describe("ward erasure", () => {
  it("the other parent sees it and may cancel; a ward with a login is refused", async () => {
    const club = await buildClub(s);
    const family = await buildFamily(s, { club });
    const request = await s.erasure.scheduleWardErasure(actor(family.guardian.id), family.child.id);
    expect(request.kind).toBe("ward_erasure");
    const seen = await s.erasure.wardPreview(actor(family.coGuardian.id), family.child.id);
    expect(seen.pending?.id).toBe(request.id);
    await s.erasure.cancelWardErasure(actor(family.coGuardian.id), family.child.id);
    expect(await auditActionsOf(t, request.id)).toEqual([
      "person.erasure.scheduled",
      "person.erasure.cancelled",
    ]);

    await t.query(
      "admin",
      "INSERT INTO accounts (person_id, email, email_verified_at, idp_subject) VALUES ($1, $2, now(), 'kid')",
      [family.child.id, `kid-${family.child.id}@example.test`],
    );
    await expect(
      s.erasure.scheduleWardErasure(actor(family.guardian.id), family.child.id),
    ).rejects.toSatisfy(isError("ward_has_login"));

    // Not a ward of the caller: not found.
    const stranger = await buildPerson(s);
    await expect(s.erasure.wardPreview(actor(stranger.id), family.child.id)).rejects.toSatisfy(
      isError("not_found"),
    );
  });
});
