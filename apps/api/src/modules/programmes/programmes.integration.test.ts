// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9, ADR 0054) through the API: a coach saves
// a cup weekend as a template (no people in it), lays it out on new dates
// across daylight saving time with slots mapped to groups, sees the preview
// with warnings and refusals, and lays it out all or nothing; the timeline
// per day; copying without a template; editions; removing only while
// untouched; club templates for every team's own groups; an event laid out
// as a draft; other clubs see nothing.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type {
  ProgrammeDetail,
  ProgrammePreview,
  ProgrammeTemplate,
  ProgrammeTimeline,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildFamily,
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function api(personId: string, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId, { mfa: true })}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let other: BuiltClub;
let coach: BuiltPerson;
let otherCoach: BuiltPerson;
let parent: BuiltPerson;
let childId: string;
let teamId: string;
let team2Id: string;
let otherTeamId: string;
let hallA: string;
let hallB: string;
let kiosk: string;
let sekretariat: string;
let templateId: string;

// The source weekend: Saturday 16 and Sunday 17 January 2027 (winter time, UTC+1).
const at = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`).toISOString();

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
  other = await buildClub(s);
  teamId = (await s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" })).id;
  team2Id = (await s.groups.createGroup(club.ctx, { name: "P2013", kind: "team" })).id;
  otherTeamId = (await s.groups.createGroup(club.ctx, { name: "F2014", kind: "team" })).id;
  coach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, team2Id, coach.id, "head_coach");
  otherCoach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, otherCoach.id);
  await s.memberships.addToGroup(club.ctx, otherTeamId, otherCoach.id, "head_coach");
  const family = await buildFamily(s, { club, childBirthDate: "2012-05-01" });
  parent = family.guardian;
  childId = family.child.id;
  await s.memberships.addToGroup(club.ctx, teamId, childId);
  hallA = (await s.activities.createLocation(club.ctx, { name: "Hall A" })).id;
  hallB = (await s.activities.createLocation(club.ctx, { name: "Hall B" })).id;
  kiosk = (await s.duties.createType(club.ctx, { name: "Kiosk", childContact: "none" })).id;
  sekretariat = (
    await s.duties.createType(club.ctx, { name: "Sekretariat", childContact: "with_children" })
  ).id;

  // Höstcupen's source: two days, two halls, matches, lunch, shifts.
  const match = async (date: string, time: string, hall: string, opponent: string) => {
    const a = await s.activities.createActivity(club.ctx, teamId, {
      kind: "match",
      title: `P2012 – ${opponent}`,
      opponent,
      startsAt: at(date, time),
      endsAt: at(
        date,
        time.replace(/^(\d\d)/, (h) => String(Number(h) + 1).padStart(2, "0")),
      ),
      locationId: hall,
      meetAt: at(date, "08:30"),
    });
    await s.duties.createShift(
      club.ctx,
      { groupId: teamId },
      {
        dutyTypeId: sekretariat,
        startsAt: at(date, time),
        endsAt: a.activity.endsAt.toISOString(),
        activityId: a.activity.id,
      },
    );
    return a.activity.id;
  };
  await match("2027-01-16", "09:00", hallA, "Kalmarby");
  await match("2027-01-16", "11:00", hallB, "Norrby");
  await match("2027-01-17", "09:00", hallA, "Söderby");
  await s.activities.createActivity(club.ctx, teamId, {
    kind: "other",
    kindLabel: "Lunch",
    title: "Lunch",
    startsAt: at("2027-01-16", "12:30"),
    endsAt: at("2027-01-16", "13:30"),
    locationText: "Skolmatsalen",
    responseMode: "none",
  });
  await s.duties.createShift(
    club.ctx,
    { groupId: teamId },
    {
      dutyTypeId: kiosk,
      startsAt: at("2027-01-16", "08:00"),
      endsAt: at("2027-01-16", "14:00"),
      needed: 2,
      locationId: hallA,
    },
  );
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("templates", () => {
  it("are saved from a group's range: relative days and local times, one slot per group, no people", async () => {
    const res = await api(coach.id, "POST", `/clubs/${club.id}/programme-templates`, {
      name: "Höstcupen",
      groupId: teamId,
      source: { groupId: teamId, from: "2027-01-16", to: "2027-01-17" },
    });
    expect(res.statusCode, res.body).toBe(201);
    templateId = res.json<{ id: string }>().id;
    const got = await api(coach.id, "GET", `/clubs/${club.id}/programme-templates/${templateId}`);
    expect(got.statusCode, got.body).toBe(200);
    const template = got.json<ProgrammeTemplate>();
    expect(template.dayCount).toBe(2);
    expect(template.slots).toEqual([{ key: "g1", label: "P2012", defaultGroupId: teamId }]);
    const activities = template.items.filter((i) => i.kind === "activity");
    const shifts = template.items.filter((i) => i.kind === "duty_shift");
    expect(activities).toHaveLength(4);
    expect(shifts).toHaveLength(4);
    expect(activities[0]).toMatchObject({
      dayOffset: 0,
      startTime: "09:00",
      endTime: "10:00",
      meetMinutesBefore: 30,
      locationId: hallA,
      slotKeys: ["g1"],
    });
    expect(activities.find((a) => a.title === "Lunch")).toMatchObject({
      activityKind: "other",
      kindLabel: "Lunch",
      responseMode: "none",
      locationText: "Skolmatsalen",
    });
    expect(shifts.filter((i) => i.parentItemId !== null)).toHaveLength(3);
    expect(template.canManage).toBe(true);
    // Nothing about people: the tables have no person columns but who created them.
    const { rows } = await t.query<{ column_name: string }>(
      "admin",
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'programme_template%'
         AND column_name LIKE '%person%'`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["created_by_person_id"]);
  });

  it("are not visible to other clubs or to coaches of other teams", async () => {
    expect(
      (await api(other.manager.id, "GET", `/clubs/${club.id}/programme-templates/${templateId}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(otherCoach.id, "GET", `/clubs/${club.id}/programme-templates/${templateId}`))
        .statusCode,
    ).toBe(403);
    const list = await api(otherCoach.id, "GET", `/clubs/${club.id}/programme-templates`);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it("refuse items past the template's days and unknown slots", async () => {
    const res = await api(
      coach.id,
      "PATCH",
      `/clubs/${club.id}/programme-templates/${templateId}`,
      {
        items: [
          {
            ref: "a",
            kind: "activity",
            activityKind: "training",
            title: "Träning",
            dayOffset: 2,
            startTime: "10:00",
            endDayOffset: 2,
            endTime: "11:00",
          },
        ],
      },
    );
    expect(res.statusCode).toBe(400);
    expect(detail(res)).toBe("programme_day_offset_invalid");
  });
});

describe("laying out", () => {
  it("keeps local times across daylight saving time and maps slots to groups", async () => {
    // Saturday 27 and Sunday 28 March 2027: summer time starts on the Sunday.
    const res = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${templateId}/preview`,
      {
        firstDay: "2027-03-27",
        slots: { g1: [team2Id] },
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const preview = res.json<ProgrammePreview>();
    expect(preview.edition).toBe("2027");
    expect(preview.lastDay).toBe("2027-03-28");
    const matches = preview.items.filter((i) => i.activityKind === "match");
    expect(matches.map((m) => m.startsAt)).toEqual([
      "2027-03-27T08:00:00.000Z",
      "2027-03-27T10:00:00.000Z",
      "2027-03-28T07:00:00.000Z",
    ]);
    expect(matches.every((m) => m.groupIds.length === 1 && m.groupIds[0] === team2Id)).toBe(true);
    expect(preview.refusals).toEqual([]);
  });

  it("refuses groups the caller does not plan", async () => {
    const res = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${templateId}/preview`,
      {
        firstDay: "2027-03-27",
        slots: { g1: [otherTeamId] },
      },
    );
    expect(res.statusCode).toBe(403);
    expect(detail(res)).toBe("group_not_managed");
  });

  it("refuses an archived place unless it is replaced, and writes nothing", async () => {
    await s.activities.updateLocation(club.ctx, hallB, { archived: true });
    const body = { firstDay: "2027-04-10", slots: { g1: [teamId] } };
    const preview = (
      await api(
        coach.id,
        "POST",
        `/clubs/${club.id}/programme-templates/${templateId}/preview`,
        body,
      )
    ).json<ProgrammePreview>();
    expect(preview.refusals.map((r) => r.code)).toContain("location_archived");
    const before = await t.query("admin", "SELECT id FROM public.activities");
    const res = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${templateId}/apply`,
      body,
    );
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toBe("programme_location_archived");
    const after = await t.query("admin", "SELECT id FROM public.activities");
    expect(after.rows.length).toBe(before.rows.length);
    await s.activities.updateLocation(club.ctx, hallB, { archived: false });
  });

  it("warns about a hall already in use, never blocking", async () => {
    await s.activities.createActivity(club.ctx, otherTeamId, {
      kind: "training",
      title: "F2014 träning",
      startsAt: new Date("2027-04-10T08:30:00+02:00").toISOString(),
      endsAt: new Date("2027-04-10T09:30:00+02:00").toISOString(),
      locationId: hallA,
    });
    const res = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${templateId}/preview`,
      {
        firstDay: "2027-04-10",
        slots: { g1: [teamId] },
      },
    );
    const preview = res.json<ProgrammePreview>();
    expect(preview.warnings.filter((w) => w.code === "location_conflict")).toHaveLength(1);
    expect(preview.refusals).toEqual([]);
  });

  let programmeId: string;

  it("creates the programme, activities and shifts at once", async () => {
    const res = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${templateId}/apply`,
      {
        firstDay: "2027-04-10",
        slots: { g1: [teamId] },
        edition: "Höstcupen 2027",
      },
    );
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{
      programme: { id: string; edition: string };
      activities: number;
      dutyShifts: number;
    }>();
    expect(created).toMatchObject({ activities: 4, dutyShifts: 4 });
    expect(created.programme.edition).toBe("Höstcupen 2027");
    programmeId = created.programme.id;
    const { rows } = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM public.tasks WHERE programme_id = $1
         AND source_activity_id IN (SELECT id FROM public.activities WHERE programme_id = $1)`,
      [programmeId],
    );
    expect(rows[0]!.n).toBe(3);
    const template = (
      await api(coach.id, "GET", `/clubs/${club.id}/programme-templates/${templateId}`)
    ).json<ProgrammeTemplate>();
    expect(template.editions.map((e) => e.edition)).toEqual(["Höstcupen 2027"]);
  });

  it("is seen as a timeline per day: organisers with conflicts, a parent their child's", async () => {
    const detailRes = await api(coach.id, "GET", `/clubs/${club.id}/programmes/${programmeId}`);
    expect(detailRes.statusCode, detailRes.body).toBe(200);
    const programme = detailRes.json<ProgrammeDetail>();
    expect(programme.days).toEqual(["2027-04-10", "2027-04-11"]);
    expect(programme.places.map((p) => p.name)).toEqual(["Hall A", "Hall B", null]);
    expect(programme.untouched).toBe(true);
    const timeline = (
      await api(
        coach.id,
        "GET",
        `/clubs/${club.id}/programmes/${programmeId}/timeline?day=2027-04-10`,
      )
    ).json<ProgrammeTimeline>();
    expect(timeline.activities).toHaveLength(3);
    expect(timeline.activities.filter((a) => a.conflict)).toHaveLength(1);
    expect(timeline.shifts.find((x) => x.needed === 2)).toMatchObject({ filled: 0, mine: false });
    const asParent = await api(
      parent.id,
      "GET",
      `/clubs/${club.id}/programmes/${programmeId}/timeline?day=2027-04-10`,
    );
    expect(asParent.statusCode, asParent.body).toBe(200);
    expect(asParent.json<ProgrammeTimeline>().activities.every((a) => !a.conflict)).toBe(true);
    const mine = await api(parent.id, "GET", `/me/programmes?clubId=${club.id}`);
    expect(mine.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toContain(programmeId);
    expect(
      (await api(other.manager.id, "GET", `/clubs/${club.id}/programmes/${programmeId}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(otherCoach.id, "GET", `/clubs/${club.id}/programmes/${programmeId}`)).statusCode,
    ).toBe(404);
  });

  it("copies to a new date without keeping a template", async () => {
    const res = await api(coach.id, "POST", `/clubs/${club.id}/programmes/${programmeId}/copy`, {
      firstDay: "2027-05-01",
    });
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<{
      programme: { id: string; edition: string | null };
      activities: number;
    }>();
    expect(copy.activities).toBe(4);
    expect(copy.programme.edition).toBeNull();
    const removed = await api(
      coach.id,
      "DELETE",
      `/clubs/${club.id}/programmes/${copy.programme.id}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const { rows } = await t.query(
      "admin",
      "SELECT id FROM public.activities WHERE programme_id = $1",
      [copy.programme.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("is removed only while untouched", async () => {
    const timeline = (
      await api(
        coach.id,
        "GET",
        `/clubs/${club.id}/programmes/${programmeId}/timeline?day=2027-04-10`,
      )
    ).json<ProgrammeTimeline>();
    const lunchOrMatch = timeline.activities.find((a) => a.kind === "match")!;
    await s.attendance.respond(
      { actorKind: "person", personId: parent.id, clubId: club.id, requestId: "test" },
      lunchOrMatch.id,
      childId,
      { status: "attending" },
    );
    const res = await api(coach.id, "DELETE", `/clubs/${club.id}/programmes/${programmeId}`);
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toBe("programme_not_untouched");
  });
});

describe("club templates and events", () => {
  it("a club template is used by a team for its own groups; an event is laid out as a draft", async () => {
    const event = await s.events.createEvent(club.ctx, {
      title: "Städdag",
      audience: "groups",
      groupIds: [teamId],
      startsAt: new Date("2027-02-06T09:00:00+01:00").toISOString(),
      activities: [
        {
          kind: "other",
          kindLabel: "Städning",
          title: "Städning",
          startsAt: new Date("2027-02-06T09:00:00+01:00").toISOString(),
          endsAt: new Date("2027-02-06T12:00:00+01:00").toISOString(),
        },
      ],
    });
    const saved = await api(club.manager.id, "POST", `/clubs/${club.id}/programme-templates`, {
      name: "Städdag",
      groupId: null,
      source: { eventId: event.event.id },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const clubTemplate = saved.json<{ id: string }>().id;
    // The coach of another team uses it for F2014.
    const list = await api(otherCoach.id, "GET", `/clubs/${club.id}/programme-templates`);
    expect(list.json<{ items: { id: string; canManage: boolean }[] }>().items).toEqual([
      expect.objectContaining({ id: clubTemplate, canManage: false }),
    ]);
    const res = await api(
      otherCoach.id,
      "POST",
      `/clubs/${club.id}/programme-templates/${clubTemplate}/apply`,
      {
        firstDay: "2027-09-04",
        slots: { g1: [otherTeamId] },
      },
    );
    expect(res.statusCode, res.body).toBe(201);
    const programme = res.json<{ programme: { eventId: string | null } }>().programme;
    expect(programme.eventId).not.toBeNull();
    const { rows } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM public.events WHERE id = $1",
      [programme.eventId],
    );
    expect(rows[0]!.status).toBe("draft");
    // Changing the club's template is for club managers.
    const patch = await api(
      otherCoach.id,
      "PATCH",
      `/clubs/${club.id}/programme-templates/${clubTemplate}`,
      {
        name: "Vårstäd",
      },
    );
    expect(patch.statusCode).toBe(403);
  });
});

describe("a full template", () => {
  it("lays out 300 items in one request with bulk inserts", async () => {
    const created = await api(coach.id, "POST", `/clubs/${club.id}/programme-templates`, {
      name: "Läger",
      groupId: teamId,
      source: { empty: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    const base = {
      parentRef: null,
      endDayOffset: 0,
      slotKeys: ["g1"],
      kindLabel: null,
      notes: null,
      locationId: null,
      locationText: "Lägergården",
      meetMinutesBefore: null,
      meetPlace: null,
      transportMode: null,
      homeAway: null,
      opponent: null,
      responseMode: null,
      dutyTypeId: null,
      needed: null,
    };
    const items = Array.from({ length: 150 }, (_, i) => {
      const day = i % 30;
      const hour = String(8 + Math.floor(i / 30) * 2).padStart(2, "0");
      const end = String(9 + Math.floor(i / 30) * 2).padStart(2, "0");
      return [
        {
          ...base,
          ref: `a${i}`,
          kind: "activity",
          activityKind: "training",
          title: `Pass ${i + 1}`,
          dayOffset: day,
          endDayOffset: day,
          startTime: `${hour}:00`,
          endTime: `${end}:00`,
        },
        {
          ...base,
          ref: `s${i}`,
          kind: "duty_shift",
          parentRef: `a${i}`,
          activityKind: null,
          locationText: null,
          title: "Kiosk",
          dayOffset: day,
          endDayOffset: day,
          startTime: `${hour}:00`,
          endTime: `${end}:00`,
          dutyTypeId: kiosk,
          needed: 1,
        },
      ];
    }).flat();
    const patched = await api(coach.id, "PATCH", `/clubs/${club.id}/programme-templates/${id}`, {
      dayCount: 30,
      slots: [{ key: "g1", label: "Laget", defaultGroupId: teamId }],
      items,
    });
    expect(patched.statusCode, patched.body).toBe(204);
    const started = Date.now();
    const res = await api(coach.id, "POST", `/clubs/${club.id}/programme-templates/${id}/apply`, {
      firstDay: "2027-07-01",
    });
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ activities: number; dutyShifts: number }>()).toMatchObject({
      activities: 150,
      dutyShifts: 150,
    });
    // Bulk inserts: well within a request's budget on a CI machine.
    expect(took).toBeLessThan(10_000);
  });
});
