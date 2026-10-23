// SPDX-License-Identifier: AGPL-3.0-only
// Adding and importing members (P1.3b) through the HTTP API and the import
// jobs: any number of guardians (four on one child), invitations from the
// club, step and foster parents with a relative's rights, duplicates only
// within the club, idempotent re-runs, sealed identity numbers in staging.

import { readFileSync } from "node:fs";

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { guardianInvitationToken } from "@clubadmin/server-kit/invitations";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildPerson,
  type BuiltClub,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import {
  type CoreServices,
  createCoreServices,
  TEST_INVITATION_TOKEN_KEY,
} from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

const SAMPLE = readFileSync(
  new URL("../../../../../docs/demodata/imports/medlemmar.csv", import.meta.url),
);

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    INVITATION_TOKEN_KEY: TEST_INVITATION_TOKEN_KEY,
    ...NO_RATE_LIMITS,
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

type Method = "GET" | "POST" | "PATCH" | "PUT";

async function api(
  personId: string,
  method: Method,
  url: string,
  options: { body?: unknown; mfa?: boolean } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await devToken(personId, { mfa: options.mfa ?? false })}`,
      },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

async function clubWithRegistrar(): Promise<{ club: BuiltClub; registrar: BuiltPerson }> {
  const club = await buildClub(s);
  const registrar = await buildPerson(s);
  await s.memberships.addMember(club.ctx, registrar.id);
  await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  return { club, registrar };
}

async function acceptClubInvitation(person: BuiltPerson, email: string) {
  const { rows } = await t.query<{ id: string }>(
    "admin",
    "SELECT id FROM guardian_invitations WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
    [email],
  );
  const token = guardianInvitationToken(TEST_INVITATION_TOKEN_KEY, rows[0]!.id, null);
  return api(person.id, "POST", "/guardian-invitations/accept", { body: { token } });
}

interface RegisterMember {
  person: { id: string };
  guardians: { person: { id: string }; kind: string }[];
  membership: { validFrom: string };
}

describe("adding a member by hand", () => {
  it("adds a child with four guardians: a member, a new person, invitations by email", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const memberParent = await buildPerson(s);
    await s.memberships.addMember(club.ctx, memberParent.id);
    const [mother, stepFather] = [await buildPerson(s), await buildPerson(s)];
    const group = await s.groups.createGroup(club.ctx, { name: "F2016", kind: "team" });

    const res = await api(registrar.id, "POST", `/clubs/${club.id}/members`, {
      body: {
        givenName: "Lova",
        familyName: "Ström",
        birthDate: "2016-05-04",
        startDate: "2024-01-15",
        groupIds: [group.id],
        guardians: [
          { guardian: { personId: memberParent.id }, kind: "parent" },
          { guardian: { email: mother.email }, kind: "parent" },
          {
            guardian: { email: stepFather.email },
            kind: "step_parent",
            consentNote: "Blankett 2024-01-10",
          },
          {
            guardian: { person: { givenName: "Gun", familyName: "Ström", phone: "070-123 45 67" } },
            kind: "relative",
            consentNote: "Blankett 2024-01-10",
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ member: RegisterMember; invitationsSent: number }>();
    expect(body.invitationsSent).toBe(2);
    expect(body.member.guardians.map((g) => g.kind).sort()).toEqual(["parent", "relative"]);
    expect(body.member.membership.validFrom.startsWith("2024-01-1")).toBe(true);
    const childId = body.member.person.id;
    expect(await auditActionsOf(t, childId)).toContain("person.created");

    // The invited guardians accept with their own logins: four guardians in all.
    expect((await acceptClubInvitation(mother, mother.email!)).statusCode).toBe(200);
    expect((await acceptClubInvitation(stepFather, stepFather.email!)).statusCode).toBe(200);
    const { rows } = await t.query<{ kind: string; rights: string[]; recorded: boolean }>(
      "admin",
      `SELECT kind, rights, recorded_by_club_id IS NOT NULL AS recorded FROM guardianships
       WHERE ward_person_id = $1 AND valid_to IS NULL ORDER BY kind`,
      [childId],
    );
    expect(rows).toEqual([
      { kind: "parent", rights: expect.any(Array) as unknown, recorded: true },
      { kind: "parent", rights: expect.any(Array) as unknown, recorded: true },
      { kind: "relative", rights: ["view_schedule"], recorded: true },
      { kind: "step_parent", rights: ["view_schedule"], recorded: true },
    ]);
    // The register shows all four (the registrar's full view).
    const register = await api(registrar.id, "GET", `/clubs/${club.id}/members?q=Lova`);
    const [row] = register.json<{ items: RegisterMember[] }>().items;
    expect(row!.guardians.map((g) => g.kind).sort()).toEqual([
      "parent",
      "parent",
      "relative",
      "step_parent",
    ]);
    // The step-father sees the child (as a linked person) on his family page.
    const wards = await api(stepFather.id, "GET", "/me/wards");
    expect(wards.json<{ wards: { person: { id: string }; kind: string }[] }>().wards).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ id: childId }) as unknown }),
    ]);
    // The mother (a full guardian of a minor) changes his rights; he cannot.
    const [step] = (
      await t.query<{ id: string }>(
        "admin",
        "SELECT id FROM guardianships WHERE ward_person_id = $1 AND kind = 'step_parent'",
        [childId],
      )
    ).rows;
    const byHim = await api(stepFather.id, "PATCH", `/guardianships/${step!.id}`, {
      body: { rights: ["view_schedule", "receive_messages"] },
    });
    expect(byHim.statusCode).not.toBe(200);
    const byMother = await api(mother.id, "PATCH", `/guardianships/${step!.id}`, {
      body: { rights: ["view_schedule", "receive_messages"] },
    });
    expect(byMother.statusCode, byMother.body).toBe(200);
  });

  it("refuses a minor's own email and a linked guardian without consent", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const minor = await api(registrar.id, "POST", `/clubs/${club.id}/members`, {
      body: {
        givenName: "Ture",
        familyName: "Ek",
        birthDate: "2015-01-01",
        invitationEmail: "ture@example.test",
      },
    });
    expect(detail(minor)).toBe("minor_email_not_allowed");
    const linked = await api(registrar.id, "POST", `/clubs/${club.id}/members`, {
      body: {
        givenName: "Ture",
        familyName: "Ek",
        birthDate: "2015-01-01",
        guardians: [
          {
            guardian: { person: { givenName: "Ulla", familyName: "Ek" } },
            kind: "foster_parent",
          },
        ],
      },
    });
    expect(linked.statusCode).toBe(400);
    // Nothing was left behind.
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM club_memberships WHERE club_id = $1",
      [club.id],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("invites an adult to their own login; a manager needs a second factor", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const res = await api(registrar.id, "POST", `/clubs/${club.id}/members`, {
      body: {
        givenName: "Vera",
        familyName: "Holm",
        birthDate: "1980-02-03",
        invitationEmail: "vera.holm@example.test",
        membershipType: "supporting",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ invitationsSent: number }>().invitationsSent).toBe(1);
    const manager = await api(club.manager.id, "POST", `/clubs/${club.id}/members`, {
      body: { givenName: "Ville", familyName: "Holm", birthDate: "1981-02-03" },
    });
    expect(manager.statusCode).toBe(403);
    const withMfa = await api(club.manager.id, "POST", `/clubs/${club.id}/members`, {
      body: { givenName: "Ville", familyName: "Holm", birthDate: "1981-02-03" },
      mfa: true,
    });
    expect(withMfa.statusCode).toBe(201);
  });
});

describe("imports", () => {
  async function importSample(club: BuiltClub, registrar: BuiltPerson, options = {}) {
    await s.groups.createGroup(club.ctx, { name: "Fotboll", kind: "section" });
    await s.groups.createGroup(club.ctx, { name: "Innebandy", kind: "section" });
    return s.imports.importFile(registrar.as(club.id) as typeof club.ctx, SAMPLE, {
      options: { consentNote: "Medlemsansökan", sendInvitations: true, ...options },
    });
  }

  it("imports the sample file: four guardians for one child, siblings share parents, a minor's email goes to a guardian", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const imported = await importSample(club, registrar);
    expect(imported.status).toBe("review");
    expect(imported.counts).toMatchObject({ rows: 6, new: 6, error: 0, duplicate: 0 });
    // Åsa, Mikael, Jonas, Gunnel, Samir, Karin: six guardians for five children.
    expect(imported.counts.guardians).toBe(6);

    const rows = await api(
      registrar.id,
      "GET",
      `/clubs/${club.id}/member-imports/${imported.id}/rows`,
      {
        mfa: true,
      },
    );
    expect(rows.statusCode, rows.body).toBe(200);
    const items = rows.json<{
      items: { name: string; issues: string[]; guardians: { kind: string; invited: boolean }[] }[];
    }>().items;
    const saga = items.find((r) => r.name === "Saga Öberg")!;
    expect(saga.guardians.map((g) => g.kind)).toEqual([
      "parent",
      "parent",
      "step_parent",
      "relative",
    ]);
    expect(saga.guardians[0]!.invited).toBe(true);
    expect(items.find((r) => r.name === "Ines Haddad")!.issues).toContain("minor_email_moved");
    // Emails are never in the preview.
    expect(rows.body).not.toContain("@example.test");

    const confirm = await api(
      registrar.id,
      "POST",
      `/clubs/${club.id}/member-imports/${imported.id}/confirm`,
      { mfa: true },
    );
    expect(confirm.statusCode, confirm.body).toBe(202);
    await s.imports.runJob(imported.id, club.id);
    const done = await s.imports.get(club.ctx, imported.id);
    expect(done.status).toBe("done");
    expect(done.counts).toMatchObject({ imported: 6, error: 0 });

    const { rows: guardians } = await t.query<{ n: number; people: number; invitations: number }>(
      "admin",
      `SELECT
         (SELECT count(*)::int FROM guardianships g JOIN club_memberships m ON m.person_id = g.ward_person_id
          WHERE m.club_id = $1 AND g.valid_to IS NULL) AS n,
         (SELECT count(DISTINCT g.guardian_person_id)::int FROM guardianships g
          JOIN club_memberships m ON m.person_id = g.ward_person_id WHERE m.club_id = $1) AS people,
         (SELECT count(*)::int FROM guardian_invitations WHERE club_id = $1) AS invitations`,
      [club.id],
    );
    // Recorded: Mikael (for both siblings, one person), Jonas, Gunnel, Karin; Åsa (for
    // both siblings) and Samir (Ines' email) are invited.
    expect(guardians[0]).toEqual({ n: 5, people: 4, invitations: 3 });
    const { rows: emails } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM account_invitations WHERE email = 'bertil.strom@example.test'",
    );
    expect(emails[0]!.n).toBe(1);
    expect(await auditActionsOf(t, imported.id)).toEqual(
      expect.arrayContaining([
        "members.import.started",
        "members.import.confirmed",
        "members.import.finished",
      ]),
    );

    // Re-running the same file skips every row.
    const again = await importSample(club, registrar);
    expect(again.counts).toMatchObject({ rows: 6, new: 0, skipped: 6 });
  });

  it("offers possible duplicates within the club only, and imports a 'different person'", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const other = await buildClub(s);
    // In another club: never matched or revealed.
    const outsider = await s.people.createPerson(other.ctx, {
      givenName: "Bertil",
      familyName: "Ström",
      birthDate: "1961-05-05",
    });
    await s.memberships.addMember(other.ctx, outsider.id);
    // In the club: same birth date and family name, another given name.
    const lookalike = await s.people.createPerson(club.ctx, {
      givenName: "Linn",
      familyName: "Sjögren",
      birthDate: "1990-02-02",
    });
    await s.memberships.addMember(club.ctx, lookalike.id);

    const imported = await importSample(club, registrar, { sendInvitations: false });
    expect(imported.counts).toMatchObject({ new: 5, duplicate: 1 });
    const page = await s.imports.rows(club.ctx, imported.id, { status: "duplicate", limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.matchPersonId).toBe(lookalike.id);
    const base = `/clubs/${club.id}/member-imports/${imported.id}`;
    const resolved = await api(registrar.id, "PATCH", `${base}/rows/${page.items[0]!.rowNumber}`, {
      body: { action: "different_person" },
      mfa: true,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json<{ status: string }>().status).toBe("new");
    await s.imports.confirm(registrar.as(club.id) as typeof club.ctx, imported.id);
    await s.imports.runJob(imported.id, club.id);
    expect((await s.imports.get(club.ctx, imported.id)).counts.imported).toBe(6);
  });

  it("never stores identity numbers in plain text and reports errors as codes", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const csv = Buffer.from(
      "Förnamn;Efternamn;Personnummer;Födelsedatum\n" +
        "Alma;Ek;20150402-0002;\n" +
        "Bo;Ek;;31.02.2015\n" +
        ";Ek;;2015-01-01\n",
      "utf8",
    );
    const imported = await s.imports.importFile(registrar.as(club.id) as typeof club.ctx, csv);
    const { rows } = await t.query<{ data: string; cells: string; issues: string[] }>(
      "admin",
      "SELECT data::text, cells, issues FROM member_import_rows WHERE import_id = $1 ORDER BY row_number",
      [imported.id],
    );
    for (const row of rows) {
      expect(row.data).not.toMatch(/20150402|0002/);
      expect(row.cells).not.toContain("Alma");
    }
    expect(rows[1]!.issues).toContain("birth_date_invalid");
    expect(rows[2]!.issues).toContain("name_missing");
  });

  it("starts with an upload link and refuses other formats; club B gets 404", async () => {
    const { club, registrar } = await clubWithRegistrar();
    const xlsx = await api(registrar.id, "POST", `/clubs/${club.id}/member-imports`, {
      body: { format: "xlsx", size: 1000 },
      mfa: true,
    });
    expect(detail(xlsx)).toBe("import_format_unsupported");
    const imported = await s.imports.importFile(
      registrar.as(club.id) as typeof club.ctx,
      Buffer.from("Förnamn;Efternamn;Födelsedatum\nAlma;Ek;2015-04-02\n"),
    );
    const other = await buildClub(s);
    const res = await api(
      other.manager.id,
      "GET",
      `/clubs/${club.id}/member-imports/${imported.id}`,
      { mfa: true },
    );
    expect(res.statusCode).toBe(404);
    const cancel = await api(
      registrar.id,
      "POST",
      `/clubs/${club.id}/member-imports/${imported.id}/cancel`,
      { mfa: true },
    );
    expect(cancel.json<{ status: string }>().status).toBe("cancelled");
  });
});
