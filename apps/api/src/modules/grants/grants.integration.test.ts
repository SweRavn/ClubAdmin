// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports through the HTTP API (P2.7 part B, ADR 0051) with the
// bundled LOK plugin: the scheme and its periods once the club enables it,
// a period's draft report (what counts and why, people through the
// presenter), locking (registrars, not managers), exporting the locked
// report's files, the audit trail and another club seeing nothing.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { GrantFiles, GrantReport, GrantSchemeList } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildPerson,
  type BuiltClub,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let club: BuiltClub;
let other: BuiltClub;
let registrar: BuiltPerson;
let coach: BuiltPerson;
let kids: BuiltPerson[];
let groupId: string;
let counted: string;
let short: string;
let periodKey: string;

const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function api(
  personId: string,
  method: "GET" | "PUT" | "POST",
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
        "accept-language": "sv",
      },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

async function activity(title: string, startsAt: string, minutes: number): Promise<string> {
  const res = await api(coach.id, "POST", `/groups/${groupId}/activities`, {
    body: {
      kind: "training",
      title,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

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
  // The manager is not also the registrar: locking needs club.grants.report.
  club = await buildClub(s, { registrar: false });
  other = await buildClub(s);
  registrar = await buildPerson(s);
  await s.memberships.addMember(club.ctx, registrar.id);
  await s.roles.assignRole(club.ctx, registrar.id, "registrar");

  const group = await s.groups.createGroup(club.ctx, {
    name: "P2014",
    kind: "team",
    sport: "Fotboll",
  });
  groupId = group.id;
  coach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, groupId, coach.id, "head_coach");
  kids = [];
  for (const birthDate of ["2014-02-01", "2015-06-01", "2016-09-01"]) {
    const kid = await buildPerson(s, { birthDate });
    await s.memberships.addMember(club.ctx, kid.id);
    await s.memberships.addToGroup(club.ctx, groupId, kid.id);
    kids.push(kid);
  }
  // Everyone joined before the sessions.
  for (const table of ["club_memberships", "group_memberships"]) {
    await t.query(
      "admin",
      `UPDATE ${table} SET valid_from = now() - interval '120 days' WHERE club_id = $1`,
      [club.id],
    );
  }
  // Two sessions on different days in the same half-year (LOK's periods).
  const day = (offset: number) => new Date(Date.now() + offset * DAY);
  const half = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth() < 6 ? 1 : 2}`;
  const [first, second] = half(day(-3)) === half(day(-2)) ? [-3, -2] : [-2, -1];
  periodKey = half(day(second));
  counted = await activity("Träning", at(second * DAY - 3 * 3_600_000), 90);
  short = await activity("Kort", at(first * DAY - 3 * 3_600_000), 30);
  for (const id of [counted, short]) {
    const res = await api(coach.id, "PUT", `/activities/${id}/attendance`, {
      body: {
        marks: [
          ...kids.map((k) => ({ personId: k.id, status: "present" })),
          { personId: coach.id, status: "present", role: "leader" },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("grant reports", () => {
  it("lists no schemes and gives no hints until the club enables LOK", async () => {
    const schemes = await api(club.manager.id, "GET", `/clubs/${club.id}/grants/schemes`);
    expect(schemes.statusCode, schemes.body).toBe(200);
    expect(schemes.json<GrantSchemeList>()).toEqual({ items: [], unavailable: [] });
    const attendance = await api(coach.id, "GET", `/activities/${short}/attendance`);
    expect(attendance.json<{ hints: unknown[] }>().hints).toEqual([]);

    const enabled = await api(club.manager.id, "PUT", `/clubs/${club.id}/plugins/se.rf.lok`, {
      body: { enabled: true },
      mfa: true,
    });
    expect(enabled.statusCode, enabled.body).toBe(204);

    const after = await api(club.manager.id, "GET", `/clubs/${club.id}/grants/schemes`);
    const list = after.json<GrantSchemeList>();
    expect(list.items).toEqual([
      expect.objectContaining({ pluginId: "se.rf.lok", key: "lok", basis: "session" }),
    ]);
    expect(list.items[0]?.periods.map((p) => p.key)).toContain(periodKey);
    const hinted = await api(coach.id, "GET", `/activities/${short}/attendance`);
    expect(hinted.json<{ hints: unknown[] }>().hints).toEqual([
      { scheme: "lok", code: "too_short" },
    ]);
  });

  it("evaluates a period's draft: what counts and why, with the plugin's texts", async () => {
    const res = await api(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=${periodKey}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json<GrantReport>();
    expect(report).toMatchObject({ pluginId: "se.rf.lok", scheme: "lok", status: "draft" });
    expect(report.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: counted, title: "Träning", counts: true, counted: 3 }),
      ]),
    );
    // The coach (41) leads but does not count as a participant.
    expect(report.people.map((p) => p.person.id)).toEqual(
      expect.arrayContaining(kids.map((k) => k.id)),
    );
    expect(report.texts["lok.too_short"]).toBeTruthy();
    expect(report.lockedAt).toBeNull();
  });

  it("refuses an unknown period and another club's people", async () => {
    const unknown = await api(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=1999-1`,
    );
    expect([unknown.statusCode, detail(unknown)]).toEqual([404, "grant_period_unknown"]);
    const outsider = await api(
      other.manager.id,
      "GET",
      `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=${periodKey}`,
    );
    expect(outsider.statusCode).toBe(404);
  });

  it("locks for registrars only, exports the locked report and audits both", async () => {
    const report = (
      await api(
        registrar.id,
        "GET",
        `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=${periodKey}`,
      )
    ).json<GrantReport>();
    const base = `/clubs/${club.id}/grants/reports/${report.id}`;

    const early = await api(registrar.id, "POST", `${base}/export`, { body: { format: "csv" } });
    expect([early.statusCode, detail(early)]).toEqual([409, "grant_report_not_locked"]);
    expect((await api(club.manager.id, "POST", `${base}/lock`, { body: {} })).statusCode).toBe(403);
    expect((await api(other.manager.id, "POST", `${base}/lock`, { body: {} })).statusCode).toBe(
      404,
    );

    const locked = await api(registrar.id, "POST", `${base}/lock`, { body: {} });
    expect(locked.statusCode, locked.body).toBe(204);
    const again = await api(registrar.id, "POST", `${base}/lock`, { body: {} });
    expect([again.statusCode, detail(again)]).toEqual([409, "grant_report_locked"]);

    const view = (
      await api(
        registrar.id,
        "GET",
        `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=${periodKey}`,
      )
    ).json<GrantReport>();
    expect(view).toMatchObject({ id: report.id, status: "locked", lockedBy: { id: registrar.id } });
    expect(view.sessions).toEqual(report.sessions);

    const exported = await api(registrar.id, "POST", `${base}/export`, {
      body: { format: "csv" },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const [file] = exported.json<GrantFiles>().files;
    expect(file).toMatchObject({ name: `lok-${periodKey}.csv`, mediaType: "text/csv" });
    const csv = Buffer.from(file!.content, "base64").toString("utf8");
    expect(csv).toContain("Fotboll");
    expect(csv).toContain("90");
    // Never the personal identity number (not stored for these people anyway).
    expect(csv).not.toMatch(/\d{8}-?\d{4}/);

    const pdf = await api(registrar.id, "POST", `${base}/export`, { body: { format: "pdf" } });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(
      Buffer.from(pdf.json<GrantFiles>().files[0]!.content, "base64").subarray(0, 5).toString(),
    ).toBe("%PDF-");

    const { rows } = await t.query<{ action: string }>(
      "admin",
      "SELECT action FROM audit.events WHERE club_id = $1 AND action LIKE 'grant.%' ORDER BY created_at, id",
      [club.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "grant.report.locked",
      "grant.report.exported",
      "grant.report.exported",
    ]);
    const status = (
      await api(
        registrar.id,
        "GET",
        `/clubs/${club.id}/grants/report?pluginId=se.rf.lok&scheme=lok&period=${periodKey}`,
      )
    ).json<GrantReport>().status;
    expect(status).toBe("exported");
  });
});
