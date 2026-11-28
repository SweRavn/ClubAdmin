// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8) through the API: the Swedish plugin is on by
// default and its requirements apply to the roles that carry one; the
// registrar ticks off an extract (a second factor, never one's own, at most
// six months old); a newer record supersedes the older; the overview shows
// missing, expiring, valid and records to delete; the club may only be
// stricter; Norway's confirmation of purpose is a request; my own status;
// chat and duties enforce the requirement; turning the plugin off lifts
// everything; other clubs see nothing; records hold metadata only.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type {
  BackgroundCheckOverview,
  BackgroundCheckRequirements,
  MyBackgroundChecks,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildBackgroundCheck,
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function api(personId: string, method: Method, url: string, body?: unknown, mfa = false) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await devToken(personId, mfa ? { mfa: true } : {})}`,
        "accept-language": "sv",
      },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const SE = "se.rf.registerutdrag";
let club: BuiltClub;
let norway: BuiltClub;
let other: BuiltClub;
let registrar: BuiltPerson;
let coach: BuiltPerson;
let assistant: BuiltPerson;
let parent: BuiltPerson;
let teamId: string;
let childId: string;

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
  club = await buildClub(s, { registrar: false });
  norway = await buildClub(s, { country: "NO" });
  other = await buildClub(s);
  registrar = await buildPerson(s);
  await s.memberships.addMember(club.ctx, registrar.id);
  await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  teamId = (await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" })).id;
  coach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  assistant = await buildPerson(s);
  await s.memberships.addMember(club.ctx, assistant.id);
  await s.memberships.addToGroup(club.ctx, teamId, assistant.id, "assistant_coach");
  const family = await buildFamily(s, { club, childBirthDate: "2015-03-01" });
  parent = family.guardian;
  childId = family.child.id;
  await s.memberships.addToGroup(club.ctx, teamId, childId);
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("requirements", () => {
  it("come from the Swedish plugin, on by default; the template coaches carry one", async () => {
    const res = await api(registrar.id, "GET", `/clubs/${club.id}/background-checks/requirements`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<BackgroundCheckRequirements>();
    expect(r.plugin).toEqual({ id: SE, enabled: true });
    expect(r.pluginRequirements.find((x) => x.category === "board")?.level).toBe("recommended");
    expect(r.roles.find((x) => x.templateKey === "head_coach")?.category).toBe(
      "regular_contact_with_children",
    );
    expect(r.roles.find((x) => x.templateKey === "member")?.category).toBeNull();
  });

  it("the club may only be stricter: a duty type is never mapped to a milder category", async () => {
    const type = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-types`, {
      name: "Övernattning",
      childContact: "with_children",
    });
    const typeId = type.json<{ id: string }>().id;
    let res = await api(registrar.id, "PUT", `/clubs/${club.id}/background-checks/requirements`, {
      clubRequirements: [
        { pluginId: SE, category: "board", checkType: "extract", recheckMonths: 36 },
        {
          pluginId: SE,
          category: "regular_contact_with_children",
          checkType: "extract",
          recheckMonths: 36,
        },
      ],
      dutyTypes: [{ id: typeId, category: "board" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: { path: string; code: string }[] }>().errors[0]).toMatchObject({
      path: "dutyTypes.0.category",
      code: "background_check_weaker",
    });
    res = await api(registrar.id, "PUT", `/clubs/${club.id}/background-checks/requirements`, {
      clubRequirements: [
        {
          pluginId: SE,
          category: "regular_contact_with_children",
          checkType: "extract",
          recheckMonths: 36,
        },
      ],
      dutyTypes: [{ id: typeId, category: "overnight" }],
    });
    expect(res.statusCode, res.body).toBe(204);
    const r = (
      await api(registrar.id, "GET", `/clubs/${club.id}/background-checks/requirements`)
    ).json<BackgroundCheckRequirements>();
    expect(r.clubRequirements).toEqual([
      {
        pluginId: SE,
        category: "regular_contact_with_children",
        checkType: "extract",
        recheckMonths: 36,
      },
    ]);
    expect(r.dutyTypes.find((d) => d.id === typeId)?.effectiveCategory).toBe("overnight");
    expect(await auditActionsOf(t, club.id)).toContain("background_check.requirements_changed");
  });

  it("the role editor sets who needs a check (a requirement, not a permission)", async () => {
    const roles = await api(club.manager.id, "GET", `/clubs/${club.id}/roles`);
    const physio = roles
      .json<{ items: { id: string; templateKey: string | null; version: number }[] }>()
      .items.find((r) => r.templateKey === "physio")!;
    const res = await api(
      club.manager.id,
      "PATCH",
      `/clubs/${club.id}/roles/${physio.id}`,
      { version: physio.version, backgroundCheckCategory: "regular_contact_with_children" },
      true,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ backgroundCheckCategory: string }>().backgroundCheckCategory).toBe(
      "regular_contact_with_children",
    );
  });
});

describe("records", () => {
  const url = () => `/clubs/${club.id}/background-checks/records`;

  it("need the verify permission and a second factor, and never one's own", async () => {
    const body = { personId: coach.id, pluginId: SE, checkType: "extract", issuedOn: day(-20) };
    expect((await api(club.manager.id, "POST", url(), body, true)).statusCode).toBe(403);
    expect((await api(coach.id, "POST", url(), body, true)).statusCode).toBe(403);
    const noMfa = await api(registrar.id, "POST", url(), body);
    expect(noMfa.statusCode).toBe(403);
    const own = await api(registrar.id, "POST", url(), { ...body, personId: registrar.id }, true);
    expect(detail(own)).toBe("background_check_own");
  });

  it("refuse an extract older than six months, with the plugin's reason next to the date", async () => {
    const res = await api(
      registrar.id,
      "POST",
      url(),
      { personId: coach.id, pluginId: SE, checkType: "extract", issuedOn: day(-200) },
      true,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: { path: string; message: string }[] }>().errors[0]).toMatchObject({
      path: "issuedOn",
      message: expect.stringContaining("sex månader") as string,
    });
  });

  it("record the dates, how and by whom; a newer record supersedes the older", async () => {
    const first = await api(
      registrar.id,
      "POST",
      url(),
      { personId: coach.id, pluginId: SE, checkType: "extract", issuedOn: day(-100) },
      true,
    );
    expect(first.statusCode, first.body).toBe(201);
    const second = await api(
      registrar.id,
      "POST",
      url(),
      {
        personId: coach.id,
        pluginId: SE,
        checkType: "extract",
        issuedOn: day(-10),
        method: "digital_mailbox",
      },
      true,
    );
    expect(second.statusCode, second.body).toBe(201);
    const { rows } = await t.query<{ closed_reason_code: string | null; method: string }>(
      "admin",
      `SELECT closed_reason_code, method FROM background_checks WHERE person_id = $1 ORDER BY issued_on`,
      [coach.id],
    );
    expect(rows).toEqual([
      { closed_reason_code: "superseded", method: "viewed" },
      { closed_reason_code: null, method: "digital_mailbox" },
    ]);
    expect(await auditActionsOf(t, coach.id)).toContain("background_check.recorded");
  });

  it("hold metadata only: no column for a document, a code or an outcome", async () => {
    const { rows } = await t.query<{ column_name: string }>(
      "admin",
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'background_checks'`,
    );
    const names = rows.map((r) => r.column_name);
    for (const banned of ["document", "file", "image", "photo", "reference", "outcome", "remark"]) {
      expect(names.some((n) => n.includes(banned))).toBe(false);
    }
    expect(names.filter((n) => n.endsWith("code"))).toEqual(["closed_reason_code"]);
  });
});

describe("the overview and my status", () => {
  it("lists missing, valid and expiring through the presenter; other clubs see nothing", async () => {
    // The assistant's check was issued 35 months ago: the club's 36 months end soon.
    await buildBackgroundCheck(s, club, assistant.id, 1050);
    const res = await api(registrar.id, "GET", `/clubs/${club.id}/background-checks/overview`);
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json<BackgroundCheckOverview>();
    expect(o.active).toBe(true);
    const status = new Map(o.items.map((i) => [i.person.id, i.status]));
    expect(status.get(coach.id)).toBe("valid");
    expect(status.get(assistant.id)).toBe("expiring");
    expect(status.has(parent.id)).toBe(false);
    const missing = await api(
      registrar.id,
      "GET",
      `/clubs/${club.id}/background-checks/overview?status=missing`,
    );
    expect(missing.json<BackgroundCheckOverview>().items.every((i) => i.status === "missing")).toBe(
      true,
    );
    const stranger = await api(
      other.manager.id,
      "GET",
      `/clubs/${club.id}/background-checks/overview`,
    );
    expect(stranger.statusCode).toBe(404);
  });

  it("shows a leader what is required and when it expires", async () => {
    const res = await api(coach.id, "GET", `/me/background-checks?clubId=${club.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const me = res.json<MyBackgroundChecks>();
    expect(me.status).toBe("valid");
    expect(me.required[0]).toMatchObject({ category: "regular_contact_with_children" });
    expect(me.expiresOn).toBe(
      (() => {
        const d = new Date(`${day(-10)}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 36);
        return d.toISOString().slice(0, 10);
      })(),
    );
    const mine = await api(parent.id, "GET", `/me/background-checks?clubId=${club.id}`);
    expect(mine.json<MyBackgroundChecks>().status).toBe("not_required");
  });

  it("lists records nobody needs any more; deleting one is audited and needs a second factor", async () => {
    await buildBackgroundCheck(s, club, parent.id);
    const o = (
      await api(
        registrar.id,
        "GET",
        `/clubs/${club.id}/background-checks/overview?status=to_delete`,
      )
    ).json<BackgroundCheckOverview>();
    const entry = o.items.find((i) => i.person.id === parent.id)!;
    expect(entry.status).toBe("to_delete");
    const recordId = entry.records[0]!.id;
    const url = `/clubs/${club.id}/background-checks/records/${recordId}`;
    expect((await api(registrar.id, "DELETE", url)).statusCode).toBe(403);
    expect((await api(registrar.id, "DELETE", url, undefined, true)).statusCode).toBe(204);
    expect(await auditActionsOf(t, parent.id)).toContain("background_check.deleted");
  });
});

describe("reminders", () => {
  it("tell the person 60 and 14 days ahead, and the club once a week (counts only)", async () => {
    expect(await s.checks.remindExpiring()).toBeGreaterThan(0);
    // Idempotent: the same stage and week are not published twice.
    await s.checks.remindExpiring();
    const { rows } = await t.query<{ type: string; payload: Record<string, unknown> }>(
      "admin",
      `SELECT type, payload FROM outbox.events
       WHERE type LIKE 'background_check.%' AND payload->>'clubId' = $1 ORDER BY type`,
      [club.id],
    );
    expect(rows.filter((r) => r.type === "background_check.expiring")).toEqual([
      {
        type: "background_check.expiring",
        payload: expect.objectContaining({ personId: assistant.id, days: 60 }) as unknown,
      },
    ]);
    const followUps = rows.filter((r) => r.type === "background_check.follow_up");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.payload).toMatchObject({ expiring: 1 });
  });
});

describe("enforcement", () => {
  let blocked: BuiltPerson;

  beforeAll(async () => {
    blocked = await buildPerson(s);
    await s.memberships.addMember(club.ctx, blocked.id);
    await s.memberships.addToGroup(club.ctx, teamId, blocked.id, "assistant_coach");
  });

  it("a leader without a valid check cannot write to a child", async () => {
    const res = await api(blocked.id, "POST", `/clubs/${club.id}/direct-chats`, {
      personId: childId,
    });
    expect(detail(res)).toBe("chat_background_check");
    // An adult may be written to.
    const adult = await api(blocked.id, "POST", `/clubs/${club.id}/direct-chats`, {
      personId: parent.id,
    });
    expect(adult.statusCode, adult.body).toBeLessThan(300);
  });

  it("a duty with children is not offered and is refused without a check; planners see who lacks one", async () => {
    const type = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-types`, {
      name: "Sekretariat",
      childContact: "with_children",
    });
    const typeId = type.json<{ id: string }>().id;
    const shift = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-shifts`, {
      dutyTypeId: typeId,
      startsAt: `${day(7)}T10:00:00Z`,
      endsAt: `${day(7)}T12:00:00Z`,
      needed: 3,
    });
    expect(shift.statusCode, shift.body).toBe(201);
    const shiftId = shift.json<{ id: string }>().id;
    const signUp = await api(
      blocked.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      {},
    );
    expect(detail(signUp), signUp.body).toBe("background_check_required");
    const assign = await api(
      club.manager.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/assignments`,
      {
        personId: blocked.id,
      },
    );
    expect(detail(assign)).toBe("background_check_required");
    // With a check the coach may; once it is gone, the planners see it.
    const ok = await api(
      club.manager.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/assignments`,
      {
        personId: coach.id,
      },
    );
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    await t.query(
      "admin",
      `UPDATE background_checks SET closed_at = now(), closed_reason_code = 'closed' WHERE person_id = $1`,
      [coach.id],
    );
    const list = await api(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/duty-shifts?from=${day(0)}&to=${day(30)}`,
    );
    const item = list
      .json<{ items: { id: string; assignments: { missingBackgroundCheck: boolean }[] }[] }>()
      .items.find((i) => i.id === shiftId)!;
    expect(item.assignments.map((a) => a.missingBackgroundCheck)).toEqual([true]);
  });

  it("turning the plugin off lifts every requirement", async () => {
    const off = await api(
      club.manager.id,
      "PUT",
      `/clubs/${club.id}/plugins/${SE}`,
      {
        enabled: false,
        config: {},
        secrets: {},
      },
      true,
    );
    expect(off.statusCode, off.body).toBe(204);
    const res = await api(blocked.id, "POST", `/clubs/${club.id}/direct-chats`, {
      personId: childId,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const o = (
      await api(registrar.id, "GET", `/clubs/${club.id}/background-checks/overview`)
    ).json<BackgroundCheckOverview>();
    expect(o.active).toBe(false);
  });
});

describe("Norway", () => {
  it("the club's confirmation of purpose is a request; a shown attest completes it", async () => {
    const leader = await buildPerson(s);
    await s.memberships.addMember(norway.ctx, leader.id);
    const registrarNo = await buildPerson(s);
    await s.memberships.addMember(norway.ctx, registrarNo.id);
    await s.roles.assignRole(norway.ctx, registrarNo.id, "registrar");
    const req = await api(
      norway.manager.id,
      "POST",
      `/clubs/${norway.id}/background-checks/requests`,
      {
        personId: leader.id,
        pluginId: "no.nif.politiattest",
        checkType: "attest",
      },
    );
    if (req.statusCode !== 201) {
      const { rows } = await t.query<{ changed_fields: string[] }>(
        "admin",
        `SELECT changed_fields FROM audit.events WHERE action = 'plugin.call_failed' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows, req.body).toEqual([]);
    }
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json<{ status: string }>().status).toBe("requested");
    const rec = await api(
      registrarNo.id,
      "POST",
      `/clubs/${norway.id}/background-checks/records`,
      {
        personId: leader.id,
        pluginId: "no.nif.politiattest",
        checkType: "attest",
        issuedOn: day(-3),
      },
      true,
    );
    expect(rec.statusCode, rec.body).toBe(201);
    const { rows } = await t.query<{ status: string }>(
      "admin",
      `SELECT status FROM background_check_requests WHERE person_id = $1`,
      [leader.id],
    );
    expect(rows).toEqual([{ status: "verified" }]);
  });
});
