// SPDX-License-Identifier: AGPL-3.0-only
// The member register through the HTTP API (P1.2): field sets per access
// level (full, limited, none), protected members, search, filters, keyset
// pages, facets, membership changes and exports.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildFamily,
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

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    // Requests never reach object storage here; the worker test writes files.
    S3_ENDPOINT: "http://127.0.0.1:9",
    S3_PUBLIC_ENDPOINT: "https://s3.clubadmin.test",
    S3_REGION: "garage",
    S3_ACCESS_KEY_ID: "GKtest",
    S3_SECRET_ACCESS_KEY: "test-secret",
    MEMBER_EXPORTS_PER_PERSON_DAY: "3",
    ...NO_RATE_LIMITS,
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

type Method = "GET" | "POST" | "PATCH";

async function api(
  personId: string,
  method: Method,
  url: string,
  options: { body?: unknown; mfa?: boolean } = {},
) {
  const token = await devToken(personId, { mfa: options.mfa ?? false });
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

interface Member {
  person: { id: string; displayName: string; protected: boolean };
  memberNumber: number;
  membershipType: string;
  groups: { groupId: string; name: string }[];
  birthDate?: string | null;
  membership?: { status: string };
  phone?: string | null;
  gender?: string | null;
  guardians?: { person: { id: string }; phone: string | null }[];
  missingConsents?: string[];
}
interface Page {
  access: string;
  items: Member[];
  nextCursor: string | null;
  totalCount: number;
}

describe("member register", () => {
  let club: BuiltClub;
  let registrar: BuiltPerson;
  let treasurer: BuiltPerson;
  let elsa: BuiltPerson;
  let hidden: BuiltPerson;
  let paused: BuiltPerson;
  let gone: BuiltPerson;
  let teamId: string;
  let family: Awaited<ReturnType<typeof buildFamily>>;

  const join = async (overrides: Parameters<typeof buildPerson>[1] = {}) => {
    const person = await buildPerson(s, overrides);
    await s.memberships.addMember(club.ctx, person.id);
    return person;
  };

  beforeAll(async () => {
    club = await buildClub(s);
    registrar = await join();
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
    treasurer = await join();
    await s.roles.assignRole(club.ctx, treasurer.id, "treasurer");
    elsa = await join({ givenName: "Elsa", familyName: "Registersson", birthDate: "2017-04-02" });
    hidden = await join({ givenName: "Nadia", familyName: "Skyddad", protectedIdentity: true });
    paused = await join({ givenName: "Paula", familyName: "Paus" });
    await s.memberships.updateMembership(club.ctx, paused.id, { status: "paused" });
    gone = await join({ givenName: "Lennart", familyName: "Lämnat" });
    await s.memberships.leaveClub(club.ctx, gone.id);
    const team = await s.groups.createGroup(club.ctx, { name: "F2017", kind: "team" });
    teamId = team.id;
    await s.memberships.addToGroup(club.ctx, team.id, elsa.id);
    await s.memberships.addToGroup(club.ctx, team.id, hidden.id);
    family = await buildFamily(s, { club, childBirthDate: "2017-09-09" });
    await s.memberships.addToGroup(club.ctx, team.id, family.child.id);

    // Elsa shared her phone and gender with the club and gave photo consent.
    await t.query(
      "admin",
      `UPDATE people SET phone = '+46 70 111 11 11', gender = 'female' WHERE id = $1`,
      [elsa.id],
    );
    await t.query("admin", `UPDATE people SET phone = '+46 70 222 22 22' WHERE id = $1`, [
      family.guardian.id,
    ]);
    await t.query(
      "admin",
      `UPDATE club_profiles SET shared_fields = '{phone,gender}' WHERE club_id = $1 AND person_id = $2`,
      [club.id, elsa.id],
    );
    await t.query(
      "admin",
      `INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
       VALUES ($1, $2, 'photo_publication', 'v1', $2)`,
      [club.id, elsa.id],
    );
  });

  const register = async (personId: string, query = "") => {
    const res = await api(personId, "GET", `/clubs/${club.id}/members?limit=200${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page>();
  };
  const ids = (page: Page) => page.items.map((i) => i.person.id);

  it("gives registrars every field, with protected members marked", async () => {
    const page = await register(registrar.id);
    expect(page.access).toBe("full");
    expect(ids(page)).toEqual(
      expect.arrayContaining([elsa.id, hidden.id, paused.id, family.child.id]),
    );
    expect(ids(page)).not.toContain(gone.id);
    expect(page.totalCount).toBe(page.items.length);

    const e = page.items.find((i) => i.person.id === elsa.id)!;
    expect(e).toMatchObject({
      birthDate: "2017-04-02",
      membership: { status: "active" },
      phone: "+46 70 111 11 11",
      gender: "female",
      groups: [{ groupId: teamId, name: "F2017" }],
    });
    expect(e.missingConsents).not.toContain("photo_publication");
    expect(page.items.find((i) => i.person.id === hidden.id)!.person.protected).toBe(true);
    // Not shared: no phone even for the registrar.
    expect(page.items.find((i) => i.person.id === registrar.id)!.phone).toBeNull();
    // Guardians of children, with their phone numbers.
    const child = page.items.find((i) => i.person.id === family.child.id)!;
    expect(child.guardians).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          person: expect.objectContaining({ id: family.guardian.id }) as unknown,
          phone: "+46 70 222 22 22",
        }),
      ]),
    );
  });

  it("gives board roles the limited list without protected members or contact fields", async () => {
    const page = await register(treasurer.id);
    expect(page.access).toBe("limited");
    expect(ids(page)).toContain(elsa.id);
    expect(ids(page)).not.toContain(hidden.id);
    // The count includes protected members, without identity.
    expect(page.totalCount).toBe(page.items.length + 1);
    const e = page.items.find((i) => i.person.id === elsa.id)!;
    expect(Object.keys(e).sort()).toEqual(["groups", "memberNumber", "membershipType", "person"]);

    for (const query of ["&bornFrom=2010", "&missingConsent=photo_publication", "&sort=joined"]) {
      const res = await api(treasurer.id, "GET", `/clubs/${club.id}/members?${query}`);
      expect(res.statusCode, query).toBe(403);
      expect(detail(res)).toBe("register_filter_not_allowed");
    }
    // A name search counts only the people the viewer may see.
    const search = await register(treasurer.id, "&q=skyddad");
    expect(search).toMatchObject({ items: [], totalCount: 0 });
  });

  it("refuses everyone else", async () => {
    const member = await join();
    expect((await api(member.id, "GET", `/clubs/${club.id}/members`)).statusCode).toBe(403);
    expect((await api(family.guardian.id, "GET", `/clubs/${club.id}/members`)).statusCode).toBe(
      403,
    );
  });

  it("searches by part of the name or the member number", async () => {
    expect(ids(await register(registrar.id, "&q=els"))).toContain(elsa.id);
    expect(ids(await register(registrar.id, "&q=ELSA%20REG"))).toEqual([elsa.id]);
    const number = (await register(registrar.id)).items.find(
      (i) => i.person.id === elsa.id,
    )!.memberNumber;
    expect(ids(await register(registrar.id, `&q=${number}`))).toContain(elsa.id);
    // LIKE patterns in the input are text.
    expect((await register(registrar.id, "&q=%25")).items).toEqual([]);
  });

  it("filters by status, type, group, role, birth year, shared gender and missing consent", async () => {
    expect(ids(await register(registrar.id, "&status=left"))).toEqual([gone.id]);
    expect(ids(await register(registrar.id, "&status=paused"))).toEqual([paused.id]);
    expect(ids(await register(registrar.id, `&groupId=${teamId}`)).sort()).toEqual(
      [elsa.id, hidden.id, family.child.id].sort(),
    );
    expect(ids(await register(registrar.id, "&role=treasurer"))).toEqual([treasurer.id]);
    expect(ids(await register(registrar.id, "&bornFrom=2017&bornTo=2017")).sort()).toEqual(
      [elsa.id, family.child.id].sort(),
    );
    expect(ids(await register(registrar.id, "&gender=female"))).toEqual([elsa.id]);
    const noPhoto = ids(
      await register(registrar.id, `&groupId=${teamId}&missingConsent=photo_publication`),
    );
    expect(noPhoto).not.toContain(elsa.id);
    expect(noPhoto).toContain(family.child.id);
    expect(ids(await register(registrar.id, "&type=honorary"))).toEqual([]);
    const bad = await api(registrar.id, "GET", `/clubs/${club.id}/members?status=nope`);
    expect(bad.statusCode).toBe(400);
  });

  it("pages with a cursor in every sort order", async () => {
    for (const sort of ["name", "member_number", "joined"]) {
      for (const order of ["asc", "desc"]) {
        const all = ids(await register(registrar.id, `&sort=${sort}&order=${order}`));
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Page = (
            await api(
              registrar.id,
              "GET",
              `/clubs/${club.id}/members?limit=2&sort=${sort}&order=${order}${cursor ? `&cursor=${cursor}` : ""}`,
            )
          ).json<Page>();
          seen.push(...ids(page));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen, `${sort} ${order}`).toEqual(all);
      }
    }
  });

  it("counts statuses, types and groups for the filter panel", async () => {
    const full = (await api(registrar.id, "GET", `/clubs/${club.id}/members/facets`)).json<{
      statuses: { value: string; count: number }[];
      groups: { groupId: string; count: number }[];
    }>();
    expect(full.statuses).toEqual(
      expect.arrayContaining([
        { value: "left", count: 1 },
        { value: "paused", count: 1 },
      ]),
    );
    expect(full.groups).toContainEqual(expect.objectContaining({ groupId: teamId, count: 3 }));
    const limited = (await api(treasurer.id, "GET", `/clubs/${club.id}/members/facets`)).json<
      Record<string, unknown>
    >();
    expect(limited).not.toHaveProperty("statuses");
  });
});

describe("membership changes", () => {
  it("pauses, resumes, changes the type and ends, audited; never the last manager", async () => {
    const club = await buildClub(s);
    const registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
    const person = await buildPerson(s);
    await s.memberships.addMember(club.ctx, person.id);
    const team = await s.groups.createGroup(club.ctx, { name: "Lag", kind: "team" });
    await s.memberships.addToGroup(club.ctx, team.id, person.id);
    const url = `/clubs/${club.id}/members/${person.id}/membership`;

    const pause = await api(registrar.id, "PATCH", url, { body: { status: "paused" } });
    expect(pause.json()).toMatchObject({ status: "paused" });
    await api(registrar.id, "PATCH", url, { body: { status: "active" } });
    const retype = await api(registrar.id, "PATCH", url, { body: { membershipType: "honorary" } });
    expect(retype.json()).toMatchObject({ status: "active", membershipType: "honorary" });

    const future = await api(registrar.id, "PATCH", url, {
      body: { status: "left", endedOn: "2999-01-01" },
    });
    expect(detail(future)).toBe("invalid_end_date");
    const ended = await api(registrar.id, "PATCH", url, { body: { status: "left" } });
    expect(ended.json()).toMatchObject({ status: "left" });
    expect(
      (await api(registrar.id, "GET", `/clubs/${club.id}/members?groupId=${team.id}`)).json<Page>()
        .items,
    ).toEqual([]);

    const {
      rows: [membership],
    } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM club_memberships WHERE club_id = $1 AND person_id = $2",
      [club.id, person.id],
    );
    expect(await auditActionsOf(t, membership!.id)).toEqual(
      expect.arrayContaining([
        "membership.paused",
        "membership.resumed",
        "membership.type.changed",
        "membership.ended",
      ]),
    );

    // The only club manager's membership cannot end.
    const last = await api(
      registrar.id,
      "PATCH",
      `/clubs/${club.id}/members/${club.manager.id}/membership`,
      {
        body: { status: "left" },
      },
    );
    expect(last.statusCode).toBe(409);
    expect(detail(last)).toBe("last_club_manager");
    // Ended on an earlier day: the end of that day in the club's time zone.
    const other = await buildPerson(s);
    await t.query(
      "admin",
      `INSERT INTO club_memberships (club_id, person_id, status, valid_from)
       VALUES ($1, $2, 'active', '2020-01-01T00:00:00Z')`,
      [club.id, other.id],
    );
    await t.query("admin", "INSERT INTO club_profiles (club_id, person_id) VALUES ($1, $2)", [
      club.id,
      other.id,
    ]);
    const backdated = await api(
      registrar.id,
      "PATCH",
      `/clubs/${club.id}/members/${other.id}/membership`,
      { body: { status: "left", endedOn: "2024-06-30" } },
    );
    expect(backdated.json()).toMatchObject({ validTo: "2024-06-30T22:00:00.000Z" });
  });
});

describe("exports", () => {
  let club: BuiltClub;
  let registrar: BuiltPerson;

  beforeAll(async () => {
    club = await buildClub(s);
    registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  });

  const request = (personId: string, body: unknown = { columns: ["name", "memberNumber"] }) =>
    api(personId, "POST", `/clubs/${club.id}/member-exports`, { body, mfa: true });

  it("queues an export, audited, with a worker job and an event for the managers", async () => {
    const res = await request(registrar.id, {
      filter: { status: ["active"] },
      columns: ["phone", "name"],
      includeProtected: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    const created = res.json<{ id: string; status: string; columns: string[]; mine: boolean }>();
    expect(created).toMatchObject({ status: "queued", columns: ["name", "phone"], mine: true });
    expect(await auditActionsOf(t, created.id)).toEqual(["members.exported"]);
    const { rows: jobs } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = $1",
      [`members:export:${created.id}`],
    );
    expect(jobs[0]!.n).toBe(1);
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM outbox.events WHERE type = 'members.exported' AND payload->>'exportId' = $1`,
      [created.id],
    );
    expect(events[0]!.n).toBe(1);

    const withoutMfa = await api(registrar.id, "POST", `/clubs/${club.id}/member-exports`, {
      body: { columns: ["name"] },
    });
    expect(withoutMfa.statusCode).toBe(403);
    const unknownColumn = await request(registrar.id, { columns: ["email"] });
    expect(unknownColumn.statusCode).toBe(400);
  });

  it("lists exports and lets only the requester download a ready file", async () => {
    const created = (await request(club.manager.id)).json<{ id: string }>();
    const list = (
      await api(registrar.id, "GET", `/clubs/${club.id}/member-exports`, { mfa: true })
    ).json<{ items: { id: string; mine: boolean; requestedBy: { id: string } }[] }>();
    expect(list.items.find((e) => e.id === created.id)).toMatchObject({
      mine: false,
      requestedBy: { id: club.manager.id },
    });

    const url = `/clubs/${club.id}/member-exports/${created.id}/download`;
    const queued = await api(club.manager.id, "GET", url, { mfa: true });
    expect(detail(queued)).toBe("export_not_available");
    await t.query(
      "admin",
      `UPDATE member_exports SET status = 'ready', row_count = 3,
         object_key = 'exports/' || club_id || '/' || id || '.csv', expires_at = now() + interval '1 day'
       WHERE id = $1`,
      [created.id],
    );
    const ready = await api(club.manager.id, "GET", url, { mfa: true });
    expect(ready.statusCode).toBe(200);
    const link = new URL(ready.json<{ url: string }>().url);
    expect(link.origin).toBe("https://s3.clubadmin.test");
    expect(link.pathname).toBe(`/clubadmin-files/exports/${club.id}/${created.id}.csv`);
    expect(link.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditActionsOf(t, created.id)).toContain("members.export.downloaded");

    expect((await api(registrar.id, "GET", url, { mfa: true })).statusCode).toBe(404);
    await t.query(
      "admin",
      "UPDATE member_exports SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [created.id],
    );
    expect(detail(await api(club.manager.id, "GET", url, { mfa: true }))).toBe(
      "export_not_available",
    );
  });

  it("limits exports per person and day, and keeps working for a read-only club", async () => {
    const other = await buildClub(s);
    await t.query("admin", "UPDATE clubs SET access_state = 'read_only' WHERE id = $1", [other.id]);
    const exportOther = () =>
      api(other.manager.id, "POST", `/clubs/${other.id}/member-exports`, {
        body: { columns: ["name"] },
        mfa: true,
      });
    for (let i = 0; i < 3; i++) expect((await exportOther()).statusCode).toBe(202);
    const limited = await exportOther();
    expect(limited.statusCode).toBe(429);
    expect(detail(limited)).toBe("export_limit_reached");
  });
});
