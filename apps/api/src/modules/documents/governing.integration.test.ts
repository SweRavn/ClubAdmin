// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents (P2.4 part A, ADR 0049 decision 1B; ADR 0037) through
// the API: series of the club, drafts edited in place, adoption with MFA
// (the version locked, the marked settings decided and applied), a new
// draft after an adoption, supersession, archiving instead of deleting, and
// readers who see adopted text only.

import { sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type {
  DocumentSeriesPage,
  FolderContent,
  GoverningDocument,
  GoverningVersionText,
  MySignatureRequestList,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { subscribeToFeatures } from "../../testing/billing.ts";
import {
  buildClub,
  buildPerson,
  type BuiltClub,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function api(
  personId: string,
  method: Method,
  url: string,
  body?: unknown,
  options: { mfa?: boolean; authAgeSeconds?: number } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId, options)}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let secretary: BuiltPerson;
let member: BuiltPerson;
let coach: BuiltPerson;
let outsider: BuiltPerson;
let seriesId: string;
let statutesId: string;

const base = () => `/clubs/${club.id}`;
const today = () => new Date().toISOString().slice(0, 10);
const STATUTES = [
  "# Stadgar för IK Test",
  "",
  "## § 1 Ändamål",
  "Föreningen bedriver idrott.",
  "",
  "## § 9 Gallring",
  "Uppgifter om tidigare medlemmar sparas i {{setting former_member_retention_months = 36}} månader.",
].join("\n");

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  await subscribeToFeatures(t, [club.id], ["documents"]);
  secretary = await buildPerson(s);
  member = await buildPerson(s);
  coach = await buildPerson(s);
  outsider = await buildPerson(s);
  for (const p of [secretary, member, coach]) await s.memberships.addMember(club.ctx, p.id);
  await s.roles.assignRole(club.ctx, secretary.id, "secretary");
  const teamId = (await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" })).id;
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("series", () => {
  it("are created by the secretary for the whole club and listed for members", async () => {
    const created = await api(secretary.id, "POST", `${base()}/document-series`, {
      name: "Stadgar",
      seriesKind: "statutes",
    });
    expect(created.statusCode).toBe(201);
    seriesId = created.json<{ id: string }>().id;

    const list = (
      await api(member.id, "GET", `${base()}/document-series`)
    ).json<DocumentSeriesPage>();
    expect(list.items.map((x) => [x.name, x.seriesKind])).toEqual([["Stadgar", "statutes"]]);
    expect(list.canManage).toBe(false);
    // Neither a coach, the club manager (without the role), nor an outsider creates one.
    for (const who of [coach, club.manager]) {
      expect(
        (
          await api(who.id, "POST", `${base()}/document-series`, {
            name: "Policyer",
            seriesKind: "policies",
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await api(outsider.id, "GET", `${base()}/document-series`)).statusCode).toBe(404);
  });

  it("take no files, subfolders or files moved into them", async () => {
    const upload = await api(secretary.id, "POST", `${base()}/folders/${seriesId}/uploads`, {
      fileName: "stadgar.pdf",
      size: 10,
    });
    expect([409, 503]).toContain(upload.statusCode);
    const sub = await api(secretary.id, "POST", `${base()}/folders/${seriesId}/folders`, {
      name: "Äldre",
    });
    expect(sub.statusCode).toBe(409);
    expect(detail(sub)).toBe("folder_series");
  });
});

describe("a governing document", () => {
  let draftId: string;

  it("is drafted, edited in place and hidden from readers until adopted", async () => {
    const created = await api(secretary.id, "POST", `${base()}/governing-documents`, {
      seriesId,
      name: "Stadgar",
      body: "# Stadgar\n\nUtkast.",
    });
    expect(created.statusCode).toBe(201);
    ({ id: statutesId, versionId: draftId } = created.json<{ id: string; versionId: string }>());

    const saved = await api(secretary.id, "PATCH", `${base()}/governing-documents/${statutesId}`, {
      body: STATUTES,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ versionId: string }>().versionId).toBe(draftId);

    const view = (
      await api(secretary.id, "GET", `${base()}/governing-documents/${statutesId}`)
    ).json<GoverningDocument>();
    expect(view.status).toBe("draft");
    expect(view.current).toBeNull();
    expect(view.draft?.body).toBe(STATUTES);
    expect(view.versions).toHaveLength(1);
    expect(view.canManage).toBe(true);
    expect(view.canAdopt).toBe(true);

    expect(
      (await api(member.id, "GET", `${base()}/governing-documents/${statutesId}`)).statusCode,
    ).toBe(404);
    const folder = (
      await api(member.id, "GET", `${base()}/folders/${seriesId}`)
    ).json<FolderContent>();
    expect(folder.documents).toEqual([]);
    // The file archive's own endpoints leave it alone.
    const renamed = await api(secretary.id, "PATCH", `${base()}/documents/${statutesId}`, {
      name: "X",
    });
    expect(detail(renamed)).toBe("document_governing");
  });

  it("is adopted only with a second factor, and with a decision body for its settings", async () => {
    const adopt = { versionId: draftId, adoptedOn: today(), reference: "Årsmöte, § 12" };
    const noMfa = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${statutesId}/adopt`,
      adopt,
    );
    expect(noMfa.statusCode).toBe(403);
    const noBody = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${statutesId}/adopt`,
      adopt,
      { mfa: true },
    );
    expect(detail(noBody)).toBe("governing_decision_body_required");
    const coachTry = await api(
      coach.id,
      "POST",
      `${base()}/governing-documents/${statutesId}/adopt`,
      { ...adopt, decisionBody: "annual_meeting" },
      { mfa: true },
    );
    expect(coachTry.statusCode).toBe(403);
  });

  it("adopted: locked, in force, readable, and its marked setting decided and applied", async () => {
    const res = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${statutesId}/adopt`,
      { versionId: draftId, adoptedOn: today(), decisionBody: "annual_meeting", reference: "§ 12" },
      { mfa: true },
    );
    expect(res.statusCode).toBe(204);

    const view = (
      await api(member.id, "GET", `${base()}/governing-documents/${statutesId}`)
    ).json<GoverningDocument>();
    expect(view.status).toBe("adopted");
    expect(view.current?.body).toBe(STATUTES);
    expect(view.current?.adoption).toMatchObject({ adoptedOn: today(), effectiveFrom: today() });
    expect(view.current?.adoption?.recordedBy?.id).toBe(secretary.id);
    expect(view.draft).toBeNull();
    expect(view.canManage).toBe(false);

    const { rows } = await t.db.withSystem("test:decisions", { clubId: club.id }, (tx) =>
      tx.execute<{
        settings: Record<string, unknown>;
        document_version_id: string;
        body: string;
      }>(sql`
        SELECT settings, document_version_id, body FROM public.club_setting_decisions
        WHERE club_id = ${club.id}::uuid`),
    );
    expect(rows).toEqual([
      {
        settings: { former_member_retention_months: 36 },
        document_version_id: draftId,
        body: "annual_meeting",
      },
    ]);
    expect((await s.clubs.getClub(club.ctx)).formerMemberRetentionMonths).toBe(36);

    // The database refuses changes to the adopted text.
    await expect(
      t.db.withSystem("test:lock", { clubId: club.id }, (tx) =>
        tx.execute(sql`UPDATE public.document_versions SET body = 'x' WHERE id = ${draftId}::uuid`),
      ),
    ).rejects.toThrow();
    expect(await auditActionsOf(t, statutesId)).toEqual(
      expect.arrayContaining(["document.created", "document.updated", "document.adopted"]),
    );
  });

  it("edited after adoption starts a new draft; the adopted text stays in force", async () => {
    const saved = await api(secretary.id, "PATCH", `${base()}/governing-documents/${statutesId}`, {
      body: `${STATUTES}\n\n## § 10 Ändring`,
    });
    const newDraft = saved.json<{ versionId: string }>().versionId;
    expect(newDraft).not.toBe(draftId);
    const view = (
      await api(secretary.id, "GET", `${base()}/governing-documents/${statutesId}`)
    ).json<GoverningDocument>();
    expect(view.current?.id).toBe(draftId);
    expect(view.draft?.id).toBe(newDraft);
    expect(view.versions.map((v) => v.number)).toEqual([2, 1]);
    // Readers see the adopted versions only, and an adopted version's text.
    const forMember = (
      await api(member.id, "GET", `${base()}/governing-documents/${statutesId}`)
    ).json<GoverningDocument>();
    expect(forMember.versions.map((v) => v.number)).toEqual([1]);
    const old = await api(
      member.id,
      "GET",
      `${base()}/governing-documents/${statutesId}/versions/${draftId}`,
    );
    expect(old.json<GoverningVersionText>().body).toBe(STATUTES);
    expect(
      (
        await api(
          member.id,
          "GET",
          `${base()}/governing-documents/${statutesId}/versions/${newDraft}`,
        )
      ).statusCode,
    ).toBe(404);
    // Adopting an older version than the draft is refused.
    const stale = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${statutesId}/adopt`,
      { versionId: draftId, adoptedOn: today(), decisionBody: "annual_meeting" },
      { mfa: true },
    );
    expect(detail(stale)).toBe("governing_draft_changed");
  });

  it("is never deleted once adopted; it is superseded or archived", async () => {
    const del = await api(secretary.id, "DELETE", `${base()}/governing-documents/${statutesId}`);
    expect(detail(del)).toBe("document_adopted");
    expect(detail(await api(secretary.id, "DELETE", `${base()}/documents/${statutesId}`))).toBe(
      "document_adopted",
    );

    const policy = await api(secretary.id, "POST", `${base()}/governing-documents`, {
      seriesId,
      name: "Nya stadgar",
      body: "# Nya stadgar\n\nInga markerade inställningar.",
    });
    const { id: newId, versionId } = policy.json<{ id: string; versionId: string }>();
    const adopted = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${newId}/adopt`,
      { versionId, adoptedOn: today(), supersedes: [statutesId] },
      { mfa: true },
    );
    expect(adopted.statusCode).toBe(204);
    const old = (
      await api(member.id, "GET", `${base()}/governing-documents/${statutesId}`)
    ).json<GoverningDocument>();
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toEqual({ id: newId, name: "Nya stadgar" });
    const fresh = (
      await api(member.id, "GET", `${base()}/governing-documents/${newId}`)
    ).json<GoverningDocument>();
    expect(fresh.supersedes).toEqual([{ id: statutesId, name: "Stadgar" }]);
    // A superseded document takes no more drafts.
    const edit = await api(secretary.id, "PATCH", `${base()}/governing-documents/${statutesId}`, {
      body: "x",
    });
    expect(detail(edit)).toBe("document_adopted");

    const archived = await api(
      secretary.id,
      "POST",
      `${base()}/governing-documents/${newId}/archive`,
    );
    expect(archived.statusCode).toBe(204);
    expect(
      (
        await api(member.id, "GET", `${base()}/governing-documents/${newId}`)
      ).json<GoverningDocument>().status,
    ).toBe("archived");
    expect(await auditActionsOf(t, statutesId)).toContain("document.superseded");
    expect(await auditActionsOf(t, newId)).toContain("document.archived");
  });

  it("refuses markers of settings that are not the board's or out of range", async () => {
    for (const marker of [
      "{{setting join_policy = open}}",
      "{{setting former_member_retention_months = 2}}",
      "{{setting nonsense = 1}}",
    ]) {
      const created = await api(secretary.id, "POST", `${base()}/governing-documents`, {
        seriesId,
        name: `Policy ${marker.length}${marker.slice(10, 14)}`,
        body: `Text ${marker}`,
      });
      const { id, versionId } = created.json<{ id: string; versionId: string }>();
      const res = await api(
        secretary.id,
        "POST",
        `${base()}/governing-documents/${id}/adopt`,
        { versionId, adoptedOn: today(), decisionBody: "board" },
        { mfa: true },
      );
      expect(detail(res)).toBe("governing_setting_invalid");
      // A draft never adopted is deleted.
      expect(
        (await api(secretary.id, "DELETE", `${base()}/governing-documents/${id}`)).statusCode,
      ).toBe(204);
    }
  });

  it("is another club's: not found", async () => {
    expect(
      (await api(outsider.id, "GET", `${base()}/governing-documents/${statutesId}`)).statusCode,
    ).toBe(404);
  });
});

describe("signing (part C)", () => {
  let minutesId: string;
  let versionId: string;

  it("names the signers; a named signer reads the draft and sees it waiting", async () => {
    const created = await api(secretary.id, "POST", `${base()}/governing-documents`, {
      seriesId,
      name: "Protokoll styrelsemöte 4",
      body: "# Protokoll\n\n## § 1 Mötets öppnande",
    });
    ({ id: minutesId, versionId } = created.json<{ id: string; versionId: string }>());
    const named = await api(
      secretary.id,
      "PUT",
      `${base()}/documents/${minutesId}/versions/${versionId}/signers`,
      {
        signers: [
          { personId: secretary.id, role: "secretary" },
          { personId: member.id, role: "adjuster" },
        ],
      },
    );
    expect(named.statusCode).toBe(204);
    // Someone outside the club is never a signer.
    const stranger = await api(
      secretary.id,
      "PUT",
      `${base()}/documents/${minutesId}/versions/${versionId}/signers`,
      { signers: [{ personId: outsider.id, role: "adjuster" }] },
    );
    expect(detail(stranger)).toBe("signers_invalid");

    const forMember = (
      await api(member.id, "GET", `${base()}/governing-documents/${minutesId}`)
    ).json<GoverningDocument>();
    expect(forMember.draft?.id).toBe(versionId);
    expect(forMember.draft?.signers.map((x) => [x.person?.id, x.role, x.mine])).toEqual([
      [secretary.id, "secretary", false],
      [member.id, "adjuster", true],
    ]);
    const waiting = (
      await api(member.id, "GET", "/me/signature-requests")
    ).json<MySignatureRequestList>();
    expect(waiting.items.map((x) => [x.documentId, x.role])).toEqual([[minutesId, "adjuster"]]);
    // A coach who is not named does not read the draft.
    expect(
      (await api(coach.id, "GET", `${base()}/governing-documents/${minutesId}`)).statusCode,
    ).toBe(404);
  });

  it("is signed with a recent second factor, the hash of exactly the version", async () => {
    const url = `${base()}/documents/${minutesId}/versions/${versionId}/signatures`;
    expect((await api(member.id, "POST", url)).statusCode).toBe(403);
    expect(
      (await api(member.id, "POST", url, undefined, { mfa: true, authAgeSeconds: 3600 }))
        .statusCode,
    ).toBe(403);
    expect((await api(coach.id, "POST", url, undefined, { mfa: true })).statusCode).toBe(404);
    const signed = await api(member.id, "POST", url, undefined, { mfa: true });
    expect(signed.statusCode).toBe(201);
    const view = (
      await api(secretary.id, "GET", `${base()}/governing-documents/${minutesId}`)
    ).json<GoverningDocument>();
    expect(signed.json<{ sha256: string }>().sha256).toBe(view.draft?.sha256);
    expect(view.draft?.signers.find((x) => x.person?.id === member.id)).toMatchObject({
      level: "simple",
      provider: "in_app",
    });
    expect(detail(await api(member.id, "POST", url, undefined, { mfa: true }))).toBe(
      "already_signed",
    );
    // The signed draft is locked.
    const edit = await api(secretary.id, "PATCH", `${base()}/governing-documents/${minutesId}`, {
      body: "changed",
    });
    expect(detail(edit)).toBe("governing_signed");
    expect(
      (await api(member.id, "GET", "/me/signature-requests")).json<MySignatureRequestList>().items,
    ).toEqual([]);
  });

  it("asks the worker for the signature page once everyone has signed", async () => {
    const url = `${base()}/documents/${minutesId}/versions/${versionId}/signatures`;
    expect((await api(secretary.id, "POST", url, undefined, { mfa: true })).statusCode).toBe(201);
    const { rows } = await t.db.withSystem("test:outbox", {}, (tx) =>
      tx.execute<{ type: string }>(sql`
        SELECT type FROM outbox.events
        WHERE type IN ('document.signed', 'document.signature_requested')
          AND payload::text LIKE ${`%${club.id}%`} ORDER BY id`),
    );
    expect(rows.map((r) => r.type)).toEqual(["document.signature_requested", "document.signed"]);
    expect(await auditActionsOf(t, minutesId)).toEqual(
      expect.arrayContaining(["document.signers.updated", "document.signed"]),
    );
    // Not made yet (the worker's job): not ready.
    const page = await api(
      member.id,
      "GET",
      `${base()}/documents/${minutesId}/versions/${versionId}/signature-page`,
    );
    expect([409, 503]).toContain(page.statusCode);
  });
});
