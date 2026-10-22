// SPDX-License-Identifier: AGPL-3.0-only
// The demo scenario (docs/seed-data.md, docs/demodata) seeded through the
// domain services: structure (snapshot of a summary), determinism, every
// persona's relationships, the replayed history, reserved test data, the
// persona picker and protected identity with the real demo data. Also the
// minimal and load scenarios.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { devToken, TEST_DEV_AUTH_KEY } from "../testing/oidc.ts";
import { summariseSeed } from "../testing/seed-summary.ts";
import { createCoreServices } from "../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../testing/test-app.ts";
import { type DemoData, loadDemoData } from "./demodata.ts";
import { type Scenario, seed } from "./runner.ts";
import { SeedClock } from "./time.ts";

const data: DemoData = loadDemoData();
const clock = new SeedClock();
const id = (key: string) => {
  const found = [...data.personas, ...data.clubs, ...data.groups].find((x) => x.key === key);
  if (!found) throw new Error(`unknown key ${key}`);
  return found.id;
};

async function seeded(
  scenario: Scenario,
  size?: number,
  billingEnabled = false,
): Promise<{ t: TestDatabase; ms: number }> {
  const t = await createTestDatabase();
  await t.query("admin", "INSERT INTO app_meta.seed_mode DEFAULT VALUES");
  const started = performance.now();
  await seed(
    {
      db: t.db,
      services: createCoreServices(t.db),
      clock,
      addPlatformOperator: async (personId) => {
        await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [
          personId,
        ]);
      },
      admin: async (sql) => {
        await t.query("admin", sql);
      },
      billingEnabled,
    },
    { scenario, data, ...(size ? { size } : {}) },
  );
  return { t, ms: performance.now() - started };
}

let first: TestDatabase;
let second: TestDatabase;
let demoMs: number;

beforeAll(async () => {
  ({ t: first, ms: demoMs } = await seeded("demo"));
  // The second run with billing on: the same people and clubs, plus billing data.
  ({ t: second } = await seeded("demo", undefined, true));
}, 120_000);
afterAll(async () => {
  await first?.drop();
  await second?.drop();
});

describe("demo scenario", () => {
  it("has billing data only with billing on: SVK paid, IKN free, FIL in a trial ending in 10 days", async () => {
    const subscriptions = (t: TestDatabase) =>
      t
        .query<{ club: string; plan: string; status: string; trial_days: number | null }>(
          "admin",
          `SELECT c.slug AS club, p.key AS plan, s.status,
                  round(extract(epoch FROM s.trial_ends_at - now()) / 86400)::int AS trial_days
           FROM billing.subscriptions s JOIN billing.plans p ON p.id = s.plan_id
           JOIN clubs c ON c.id = s.club_id ORDER BY c.slug`,
        )
        .then((r) => r.rows);
    expect(await subscriptions(first)).toEqual([]);
    const withBilling = await subscriptions(second);
    const byClub = Object.fromEntries(withBilling.map((r) => [r.club, r]));
    expect(byClub[data.clubs.find((c) => c.key === "svk")!.slug]).toMatchObject({
      plan: "standard",
      status: "active",
    });
    expect(byClub[data.clubs.find((c) => c.key === "ikn")!.slug]).toMatchObject({
      plan: "free",
      status: "active",
    });
    expect(byClub[data.clubs.find((c) => c.key === "fil")!.slug]).toMatchObject({
      plan: "standard",
      status: "trial",
      trial_days: 10,
    });
  });

  it("creates exactly the clubs, groups and personas of docs/seed-data.md", async () => {
    expect(await summariseSeed(first, data)).toMatchSnapshot();
  });

  it("is deterministic: identical IDs and summaries", async () => {
    expect(await summariseSeed(second, data)).toEqual(await summariseSeed(first, data));
    const ids = async (t: TestDatabase) =>
      (await t.query<{ id: string }>("admin", "SELECT id FROM people ORDER BY id")).rows.map(
        (r) => r.id,
      );
    expect(await ids(second)).toEqual(await ids(first));
    expect(await ids(first)).toEqual(
      expect.arrayContaining(data.personas.filter((p) => p.login !== "invited").map((p) => p.id)),
    );
  });

  it("matches every relationship in docs/demodata", async () => {
    const summary = (await summariseSeed(first, data)).personas as Record<
      string,
      { memberships: string[]; roles: string[]; groups: string[]; guardians: string[] }
    >;
    const r = data.relationships;
    const movedFrom = new Set(
      data.history.flatMap((h) => (h.action === "group.move" ? [`${h.person}/${h.from}`] : [])),
    );
    for (const m of r.memberships) {
      expect(summary[m.person]!.memberships, `${m.person} in ${m.club}`).toContain(
        `${m.club}: ${m.status} (${m.membershipType})`,
      );
    }
    for (const role of r.roles) {
      expect(summary[role.person]!.roles, `${role.person} ${role.role}`).toContain(
        `${role.club}: ${role.role}${role.until ? " (ended)" : ""}`,
      );
    }
    for (const g of r.groupMemberships) {
      const ended = movedFrom.has(`${g.person}/${g.group}`);
      expect(summary[g.person]!.groups, `${g.person} in ${g.group}`).toContain(
        `${g.group}: ${g.function}${ended ? " (ended)" : ""}`,
      );
    }
    for (const g of r.guardianships.filter((x) => x.status === "active")) {
      expect(
        summary[g.ward]!.guardians.some((x) => x.startsWith(`${g.guardian}: ${g.kind} active`)),
        `${g.guardian} of ${g.ward}`,
      ).toBe(true);
    }
    for (const c of data.clubs) {
      const founder = summary[c.foundedBy]!.memberships;
      expect(founder.some((m) => m.startsWith(`${c.key}: active`))).toBe(true);
    }
  });

  it("replays history with the right actors and past times", async () => {
    const change = async (table: string, recordId: string, column: string) =>
      (
        await first.query<{ actor: string | null; kind: string; days: number }>(
          "admin",
          `SELECT actor_person_id AS actor, actor_kind AS kind,
                  round(extract(epoch FROM now() - changed_at) / 86400)::int AS days
           FROM history.record_changes
           WHERE table_name = $1 AND record_id = $2 AND $3 = ANY (changed_columns) AND operation = 'UPDATE'
           ORDER BY changed_at DESC LIMIT 1`,
          [table, recordId, column],
        )
      ).rows[0];
    // Erik updated his own phone number two months ago.
    const phone = await change("public.people", id("erik"), "phone");
    expect(phone).toMatchObject({ actor: id("erik"), kind: "person" });
    expect(phone!.days).toBeGreaterThanOrEqual(58);
    expect(phone!.days).toBeLessThanOrEqual(62);

    // Anna accepted Peter's hand-over last year, which ended his manager role.
    const { rows: roles } = await first.query<{ id: string; valid_to: Date }>(
      "admin",
      "SELECT id, valid_to FROM club_role_assignments WHERE person_id = $1 AND club_id = $2 AND role = 'club_manager'",
      [id("peter"), id("svk")],
    );
    expect(roles).toHaveLength(1);
    const ended = await change("public.club_role_assignments", roles[0]!.id, "valid_to");
    expect(ended).toMatchObject({ actor: id("anna"), kind: "person" });
    expect(ended!.days).toBeGreaterThanOrEqual(364);
    expect(Math.abs(roles[0]!.valid_to.getTime() - clock.at("-1y").getTime())).toBeLessThan(
      86_400_000,
    );

    // Anna moved Elsa from Minivolley to F2017 half a year ago.
    const { rows: moved } = await first.query<{ id: string }>(
      "admin",
      "SELECT id FROM group_memberships WHERE person_id = $1 AND group_id = $2",
      [id("elsa"), id("svk-minivolley")],
    );
    expect(await change("public.group_memberships", moved[0]!.id, "valid_to")).toMatchObject({
      actor: id("anna"),
    });

    // Anna approved Johan's join request last year.
    const { rows: johan } = await first.query<{ id: string }>(
      "admin",
      "SELECT id FROM join_requests WHERE person_id = $1 AND club_id = $2 AND status = 'approved'",
      [id("johan"), id("svk")],
    );
    const approved = await change("public.join_requests", johan[0]!.id, "status");
    expect(approved).toMatchObject({ actor: id("anna") });
    expect(approved!.days).toBeGreaterThanOrEqual(364);

    // A system job expired an offer yesterday.
    const { rows: expired } = await first.query<{ id: string }>(
      "admin",
      "SELECT id FROM group_waitlist_entries WHERE status = 'expired'",
    );
    expect(expired).toHaveLength(1);
    expect(await change("public.group_waitlist_entries", expired[0]!.id, "status")).toMatchObject({
      actor: null,
      kind: "system_job",
      days: 1,
    });

    // Backdating relationships wrote no history of its own.
    const { rows: seedJobs } = await first.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM history.record_changes WHERE request_id = 'job:seed:backdate'",
    );
    expect(seedJobs[0]!.n).toBe(0);
  });

  it("uses reserved test data only", async () => {
    const { rows } = await first.query<{ email: string }>(
      "admin",
      `SELECT email FROM accounts UNION ALL SELECT email FROM guardian_invitations
       UNION ALL SELECT email FROM invitations WHERE email IS NOT NULL
       UNION ALL SELECT email FROM account_invitations`,
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const { email } of rows) expect(email).toMatch(/\.test$/);
    const { rows: numbers } = await first.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM people WHERE personal_identity_number IS NOT NULL",
    );
    expect(numbers[0]!.n).toBe(0);
  });

  it("seeds in under 15 seconds", () => {
    expect(demoMs).toBeLessThan(15_000);
  });
});

describe("with the API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp(
      {
        NODE_ENV: "development",
        DATABASE_URL: first.url("app"),
        DEV_AUTH: "true",
        DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
        ...NO_RATE_LIMITS,
      },
      [],
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  const get = async (personKey: string, url: string) =>
    app.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${await devToken(id(personKey))}` },
      });

  it("lists the personas with descriptions in the DEV_AUTH picker", async () => {
    const res = await app.app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/api/v1/dev/personas" });
    const { personas } = res.json<{
      personas: { person: { id: string }; description: string | null; hasAccount: boolean }[];
    }>();
    for (const p of data.personas.filter((x) => x.login !== "invited")) {
      const listed = personas.find((x) => x.person.id === p.id);
      expect(listed?.description, p.key).toBe(p.description);
      expect(listed?.hasAccount, p.key).toBe(p.login === "account");
    }
  });

  const roster = async (viewer: string, group: string) =>
    (await get(viewer, `/api/v1/groups/${id(group)}/members`)).json<{
      items: { person: { id: string; protected: boolean } }[];
      totalCount: number;
    }>();
  const entry = async (viewer: string, group: string, person: string) =>
    (await roster(viewer, group)).items.find((i) => i.person.id === person);

  it("hides Nadia from other members, shows her with the icon to leaders, managers and Samira", async () => {
    const nadia = id("nadia");
    const asMaja = await roster("maja", "ikn-f2015");
    expect(asMaja.items.map((i) => i.person.id)).not.toContain(nadia);
    expect(asMaja.totalCount).toBe(asMaja.items.length + 1);
    for (const viewer of ["erik", "karin", "samira"]) {
      expect((await entry(viewer, "ikn-f2015", nadia))?.person.protected, viewer).toBe(true);
    }
  });

  it("applies the club-level flag Anna set on a Herr senior player", async () => {
    const { rows } = await first.query<{ person_id: string }>(
      "admin",
      "SELECT person_id FROM club_profiles WHERE club_id = $1 AND protected_identity_club",
      [id("svk")],
    );
    expect(rows).toHaveLength(1);
    const flagged = rows[0]!.person_id;
    expect((await entry("johan", "svk-herr", flagged))?.person.protected).toBe(true);
    expect((await entry("anna", "svk-herr", flagged))?.person.protected).toBe(true);
    expect(await entry("lars", "svk-herr", flagged)).toBeUndefined();
  });

  it("hides Samira (protected guardian) from a coach, not from the club manager", async () => {
    const guardians = async (viewer: string) =>
      (await get(viewer, `/api/v1/people/${id("nadia")}?clubId=${id("ikn")}`)).json<{
        guardians: { person: { id: string; protected: boolean } }[];
      }>().guardians;
    expect((await guardians("erik")).map((g) => g.person.id)).not.toContain(id("samira"));
    expect(
      (await guardians("karin")).find((g) => g.person.id === id("samira"))?.person.protected,
    ).toBe(true);
  });
});

describe("minimal and load scenarios", () => {
  it("minimal: one club, one group, three people", async () => {
    const { t } = await seeded("minimal");
    try {
      const count = async (table: string) =>
        (await t.query<{ n: number }>("admin", `SELECT count(*)::int AS n FROM ${table}`)).rows[0]!
          .n;
      expect(await count("clubs")).toBe(1);
      expect(await count("groups")).toBe(1);
      expect(await count("people")).toBe(3);
      expect(await count("guardianships")).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it("load --size 2: two clubs of 200 people", async () => {
    const { t } = await seeded("load", 2);
    try {
      const { rows } = await t.query<{
        clubs: number;
        people: number;
        members: number;
        managers: number;
      }>(
        "admin",
        `SELECT (SELECT count(*) FROM clubs)::int AS clubs, (SELECT count(*) FROM people)::int AS people,
                (SELECT count(*) FROM club_memberships)::int AS members,
                (SELECT count(*) FROM club_role_assignments WHERE role = 'club_manager')::int AS managers`,
      );
      expect(rows[0]).toEqual({ clubs: 2, people: 400, members: 320, managers: 2 });
    } finally {
      await t.drop();
    }
  });
});
