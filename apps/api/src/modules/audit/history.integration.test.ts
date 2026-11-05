// SPDX-License-Identifier: AGPL-3.0-only
// History panels, the club-wide changes and the audit log (P1.9, ADR 0042)
// over HTTP on the demo scenario: who may read which history, what the
// entries show, field visibility, erased and protected people, paging and
// the period limits.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { AuditPage, HistoryItem, HistoryPage } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDemoData } from "../../seed/demodata.ts";
import { seed } from "../../seed/runner.ts";
import { SeedClock } from "../../seed/time.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

const data = loadDemoData();
const key = (k: string) => {
  const found = [...data.personas, ...data.clubs, ...data.groups].find((x) => x.key === k);
  if (!found) throw new Error(`unknown key ${k}`);
  return found.id;
};

let t: TestDatabase;
let app: TestApp;
let matchId: string;

async function get(persona: string, url: string, options: { mfa?: boolean } = {}) {
  const token = await devToken(key(persona), { mfa: options.mfa ?? true });
  return app.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

async function page<T = HistoryPage>(persona: string, url: string): Promise<T> {
  const response = await get(persona, url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

const svk = () => key("svk");
const personUrl = (person: string, query = "") =>
  `/api/v1/people/${key(person)}/history?clubId=${svk()}${query}`;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.query("admin", "INSERT INTO app_meta.seed_mode DEFAULT VALUES");
  await seed(
    {
      db: t.db,
      services: createCoreServices(t.db),
      clock: new SeedClock(),
      addPlatformOperator: async (personId: string) => {
        await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [
          personId,
        ]);
      },
      admin: async (sql: string) => {
        await t.query("admin", sql);
      },
      billingEnabled: false,
    },
    { scenario: "demo", data },
  );
  const { rows } = await t.query<{ id: string }>(
    "admin",
    `SELECT a.id FROM activities a JOIN activity_groups ag ON ag.activity_id = a.id
     WHERE ag.group_id = $1 AND a.kind = 'match' ORDER BY a.starts_at LIMIT 1`,
    [key("svk-f2017")],
  );
  matchId = rows[0]!.id;
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    ...NO_RATE_LIMITS,
  });
}, 300_000);
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("who reads history", () => {
  it("lets the registrar read a member's, a group's and an activity's history, not the audit log", async () => {
    expect((await get("johan", personUrl("elsa"))).statusCode).toBe(200);
    expect((await get("johan", `/api/v1/groups/${key("svk-f2017")}/history`)).statusCode).toBe(200);
    expect((await get("johan", `/api/v1/activities/${matchId}/history`)).statusCode).toBe(200);
    expect((await get("johan", `/api/v1/clubs/${svk()}/audit-events`)).statusCode).toBe(403);
    expect((await get("johan", `/api/v1/clubs/${svk()}/history`)).statusCode).toBe(403);
  });

  it("refuses coaches, owners, parents and relatives", async () => {
    expect((await get("erik", `/api/v1/activities/${matchId}/history`)).statusCode).toBe(403);
    expect((await get("erik", `/api/v1/groups/${key("svk-f2017")}/history`)).statusCode).toBe(403);
    // Person routes deny with 404 (ADR 0025: a person's existence is not confirmed).
    expect((await get("erik", personUrl("elsa"))).statusCode).toBe(404);
    // Mikael is Elsa's father: parents get their child's history in the data export.
    expect((await get("mikael", personUrl("elsa"))).statusCode).toBe(404);
    // Anna, her mother, reads it as a club manager of SVK.
    expect((await get("anna", personUrl("elsa"))).statusCode).toBe(200);
    expect((await get("gunilla", personUrl("alva"))).statusCode).toBe(404);
  });

  it("keeps the audit log and the club-wide changes to club managers with a second factor", async () => {
    expect((await get("sara", `/api/v1/clubs/${svk()}/audit-events`)).statusCode).toBe(200);
    expect((await get("sara", `/api/v1/clubs/${svk()}/history`)).statusCode).toBe(200);
    const withoutMfa = await get("sara", `/api/v1/clubs/${svk()}/audit-events`, { mfa: false });
    expect(withoutMfa.statusCode).toBe(403);
    expect(withoutMfa.json<{ type: string }>().type).toMatch(/mfa-required/);
  });

  it("answers 404 to another club's people (tenant isolation)", async () => {
    expect((await get("karin", `/api/v1/clubs/${svk()}/audit-events`)).statusCode).toBe(404);
    expect((await get("karin", `/api/v1/clubs/${svk()}/history`)).statusCode).toBe(404);
    expect((await get("karin", personUrl("elsa"))).statusCode).toBe(404);
  });
});

describe("history entries", () => {
  it("shows Elsa's move from Minivolley to F2017 by Anna, with the groups named", async () => {
    const { items } = await page("johan", personUrl("elsa", "&limit=100"));
    const memberships = items.filter((i) => i.resource === "group_membership");
    const groupNames = memberships.flatMap((i) =>
      i.about.flatMap((a) => (a.kind === "record" && a.type === "group" ? [a.name] : [])),
    );
    expect(groupNames).toEqual(expect.arrayContaining(["F2017"]));
    const byAnna = memberships.filter(
      (i) => i.actor.kind === "person" && i.actor.person.id === key("anna"),
    );
    expect(byAnna.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.about.some((a) => a.kind === "hidden_person")).toBe(false);
      for (const change of item.changes) {
        expect(["id", "club_id", "created_at", "updated_at"]).not.toContain(change.column);
      }
    }
  });

  it("shows the seeded stories: Johan's type change, Sara's capacity change, Erik's moved match", async () => {
    const elsa = await page("johan", personUrl("elsa", "&limit=100"));
    const retyped = elsa.items.find((i) =>
      i.changes.some((c) => c.column === "membership_type" && c.kind === "value"),
    );
    expect(retyped?.actor).toMatchObject({ kind: "person", person: { id: key("johan") } });
    expect(retyped?.changes.find((c) => c.column === "membership_type")?.new).toEqual({
      type: "enum",
      enumKey: "membershipTypes",
      value: "family",
    });

    const group = await page("johan", `/api/v1/groups/${key("svk-f2017")}/history?limit=100`);
    const capacity = group.items
      .flatMap((i) => i.changes.map((c) => ({ i, c })))
      .find(({ c }) => c.column === "capacity" && c.old !== null);
    expect(capacity?.c).toMatchObject({
      old: { type: "number", value: 12 },
      new: { type: "number", value: 10 },
    });
    expect(capacity?.i.actor).toMatchObject({ kind: "person", person: { id: key("sara") } });

    const { rows } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM activities WHERE title = 'Seriematch mot Älvdalens VBK' LIMIT 1",
    );
    const away = await page("johan", `/api/v1/activities/${rows[0]!.id}/history`);
    const moved = away.items.find((i) => i.changes.some((c) => c.column === "starts_at"));
    expect(moved?.actor).toMatchObject({ kind: "person", person: { id: key("erik") } });
  });

  it("pages newest first with an opaque cursor and refuses a bad one", async () => {
    const first = await page("johan", personUrl("elsa", "&limit=2"));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(
      "johan",
      personUrl("elsa", `&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );
    const all = [...first.items, ...second.items];
    const times = all.map((i) => i.changedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect((await get("johan", personUrl("elsa", "&cursor=bm9wZQ"))).statusCode).toBe(400);
    expect(first.retentionMonths).toBe(24);
  });

  it("shows system jobs as automatic with the job's name", async () => {
    const { items } = await page("sara", `/api/v1/clubs/${svk()}/history?limit=100`);
    const jobs = items.filter(
      (i): i is HistoryItem & { actor: { kind: "system" } } => i.actor.kind === "system",
    );
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("filters the club-wide changes by kind of record and actor within at most 90 days", async () => {
    const from = new Date(Date.now() - 89 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const groups = await page(
      "sara",
      `/api/v1/clubs/${svk()}/history?table=group_membership&${range}`,
    );
    expect(groups.items.every((i) => i.resource === "group_membership")).toBe(true);
    const long = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const tooLong = await get(
      "sara",
      `/api/v1/clubs/${svk()}/history?table=group_membership&from=${encodeURIComponent(long)}`,
    );
    expect(tooLong.statusCode).toBe(400);
    expect(
      (await get("sara", `/api/v1/clubs/${svk()}/history?actorId=${key("anna")}`)).statusCode,
    ).toBe(400);
  });

  it("lists the club's audit log by category, with actions and field names only", async () => {
    const all = await page<AuditPage>("sara", `/api/v1/clubs/${svk()}/audit-events?limit=100`);
    expect(all.items.length).toBeGreaterThan(0);
    for (const item of all.items) expect(item).not.toHaveProperty("ipHash");
    const roles = await page<AuditPage>(
      "sara",
      `/api/v1/clubs/${svk()}/audit-events?category=roles&limit=100`,
    );
    expect(roles.items.every((i) => i.category === "roles")).toBe(true);
  });

  it("serves the club page's own panel", async () => {
    const { items } = await page("sara", `/api/v1/clubs/${svk()}/history?scope=club&limit=100`);
    const kinds = new Set(items.map((i) => i.resource));
    expect(
      [...kinds].every((k) =>
        [
          "club",
          "location",
          "club_phone_number",
          "consent_text",
          "club_setting_decision",
          "club_privacy_policy",
          "support_access_grant",
        ].includes(k),
      ),
    ).toBe(true);
  });
});

describe("field visibility and people", () => {
  it("shows a phone change only while the person shares the phone with the club", async () => {
    const phoneChanges = async () =>
      (await page("sara", personUrl("erik", "&limit=100"))).items.filter((i) =>
        i.changes.some((c) => c.column === "phone"),
      );
    // Erik shares his phone with SVK (demo): his change is shown with its values.
    const shown = await phoneChanges();
    expect(shown.length).toBeGreaterThan(0);
    const change = shown[0]!.changes.find((c) => c.column === "phone")!;
    expect(change.kind).toBe("value");
    await t.query(
      "admin",
      "UPDATE club_profiles SET shared_fields = '{}' WHERE club_id = $1 AND person_id = $2",
      [svk(), key("erik")],
    );
    try {
      // No longer shared: not even the fact that it changed.
      expect(await phoneChanges()).toEqual([]);
    } finally {
      await t.query(
        "admin",
        "UPDATE club_profiles SET shared_fields = '{phone}' WHERE club_id = $1 AND person_id = $2",
        [svk(), key("erik")],
      );
    }
  });

  it("logs reading a protected member's history as a view of the protected person", async () => {
    const { rows } = await t.query<{ person_id: string }>(
      "admin",
      "SELECT person_id FROM club_profiles WHERE club_id = $1 AND protected_identity_club LIMIT 1",
      [svk()],
    );
    const protectedId = rows[0]!.person_id;
    const response = await get("johan", `/api/v1/people/${protectedId}/history?clubId=${svk()}`);
    expect(response.statusCode).toBe(200);
    const { rows: logged } = await t.query<{ changed_fields: string[] }>(
      "admin",
      `SELECT changed_fields FROM audit.events WHERE action = 'person.protected.viewed'
       AND resource_id = $1 AND actor_person_id = $2`,
      [protectedId, key("johan")],
    );
    expect(logged.map((r) => r.changed_fields)).toContainEqual(["history"]);
  });

  it("shows an erased person as a deleted user, never their values", async () => {
    const audit = await page<AuditPage>("sara", `/api/v1/clubs/${svk()}/audit-events?limit=100`);
    const erased = audit.items.filter(
      (i) => i.actor.kind === "erased" || i.about?.kind === "erased_person",
    );
    expect(erased.length).toBeGreaterThan(0);
    const club = await page("sara", `/api/v1/clubs/${svk()}/history?limit=100`);
    for (const item of club.items) {
      for (const change of item.changes) {
        if (change.kind !== "value") expect([change.old, change.new]).toEqual([null, null]);
      }
    }
  });

  it("shows notes on answers to club managers", async () => {
    const { items } = await page("sara", `/api/v1/clubs/${svk()}/history?limit=100`);
    const notes = items.flatMap((i) =>
      i.resource === "activity_response" ? i.changes.filter((c) => c.column === "note") : [],
    );
    expect(notes.every((c) => c.kind === "value")).toBe(true);
  });
});
