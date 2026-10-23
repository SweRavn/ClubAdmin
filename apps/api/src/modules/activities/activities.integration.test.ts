// SPDX-License-Identifier: AGPL-3.0-only
// Activities through the HTTP API (P1.4, ADR 0034): series with skipped
// dates, public holidays and a daylight saving change; changing a series
// from a date and "this and following"; joint activities; the group and
// club calendars; double bookings; "My schedule" for a family across clubs.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { ON_BEHALF_OF_HEADER } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  actor,
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
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function api(
  personId: string,
  method: Method,
  url: string,
  options: { body?: unknown; onBehalfOf?: string } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await devToken(personId)}`,
  };
  if (options.onBehalfOf) headers[ON_BEHALF_OF_HEADER] = options.onBehalfOf;
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
async function clubAudit(clubId: string): Promise<string[]> {
  const { rows } = await t.query<{ action: string }>(
    "admin",
    "SELECT action FROM audit.events WHERE club_id = $1 ORDER BY created_at, id",
    [clubId],
  );
  return rows.map((r) => r.action);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

/** A local date `offset` days from today (UTC; the tests leave a margin around "today"). */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
/** An hour later. */
const later = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();
const range = (fromDay: string, toDay: string) => `from=${fromDay}T00:00:00Z&to=${toDay}T23:59:59Z`;

interface ActivityJson {
  id: string;
  seriesId: string | null;
  title: string;
  status: string;
  startsAt: string;
  endsAt: string;
  detached: boolean;
  sequence: number;
  leaderNotes?: string | null;
  location: { id: string; name: string } | null;
  groups: { id: string; name: string }[];
  canManage: boolean;
}
interface SeriesChangeJson {
  series: { id: string; startsOn: string; endsOn: string; sessions: number; skipDates: string[] };
  created: number;
  updated: number;
  removed: number;
}
interface ScheduleJson {
  items: {
    activityId: string;
    title: string;
    club: { id: string };
    groups: { id: string }[];
    people: { id: string }[];
    place: string | null;
    status: string;
    changed: boolean;
  }[];
  people: { id: string }[];
  nextCursor: string | null;
}

/** A club with a team, its head coach and a member. */
async function team(name = "F2015"): Promise<{
  club: BuiltClub;
  groupId: string;
  coach: BuiltPerson;
  member: BuiltPerson;
}> {
  const club = await buildClub(s);
  const group = await s.groups.createGroup(club.ctx, { name, kind: "team" });
  const coach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, group.id, coach.id, "head_coach");
  const member = await buildPerson(s);
  await s.memberships.addMember(club.ctx, member.id);
  await s.memberships.addToGroup(club.ctx, group.id, member.id);
  return { club, groupId: group.id, coach, member };
}

async function calendar(personId: string, groupId: string, from: string, to: string) {
  const res = await api(personId, "GET", `/groups/${groupId}/activities?${range(from, to)}`);
  expect(res.statusCode).toBe(200);
  return res.json<{ items: ActivityJson[] }>().items;
}

describe("series", () => {
  it("skips dates and public holidays, and keeps local times across a daylight saving change", async () => {
    const { club, groupId, coach } = await team();
    // Thursdays around Christmas 2026 (Sweden): 24 and 31 December are holidays here.
    const body = {
      slots: [{ weekday: 4, startTime: "18:00", durationMinutes: 90 }],
      startsOn: "2026-12-10",
      endsOn: "2027-01-14",
      skipDates: ["2027-01-07"],
      skipPublicHolidays: true,
    };
    const preview = await api(coach.id, "POST", `/groups/${groupId}/activity-series/preview`, {
      body,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      timeZone: "Europe/Stockholm",
      sessions: [
        {
          date: "2026-12-10",
          startsAt: "2026-12-10T17:00:00.000Z",
          endsAt: "2026-12-10T18:30:00.000Z",
        },
        {
          date: "2026-12-17",
          startsAt: "2026-12-17T17:00:00.000Z",
          endsAt: "2026-12-17T18:30:00.000Z",
        },
        {
          date: "2027-01-14",
          startsAt: "2027-01-14T17:00:00.000Z",
          endsAt: "2027-01-14T18:30:00.000Z",
        },
      ],
      skipped: [
        { date: "2026-12-24", holiday: true },
        { date: "2026-12-31", holiday: true },
        { date: "2027-01-07", holiday: false },
      ],
    });

    // Tuesdays across the end of summer time (25 October 2026): 18:00 local stays 18:00.
    const created = await api(coach.id, "POST", `/groups/${groupId}/activity-series`, {
      body: {
        title: "Träning",
        slots: [{ weekday: 2, startTime: "18:00", durationMinutes: 60 }],
        startsOn: "2026-10-13",
        endsOn: "2026-11-03",
        leaderNotes: "Cones in the storeroom",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<SeriesChangeJson>()).toMatchObject({ created: 4, series: { sessions: 4 } });
    const sessions = await calendar(coach.id, groupId, "2026-10-01", "2026-11-30");
    expect(sessions.map((a) => a.startsAt)).toEqual([
      "2026-10-13T16:00:00.000Z",
      "2026-10-20T16:00:00.000Z",
      "2026-10-27T17:00:00.000Z",
      "2026-11-03T17:00:00.000Z",
    ]);
    expect(sessions[0]).toMatchObject({ canManage: true, leaderNotes: "Cones in the storeroom" });
    expect(await clubAudit(club.id)).toContain("activity.series.created");
  });

  it("refuses series longer than 400 days and times that do not exist", async () => {
    const { groupId, coach } = await team();
    const tooLong = await api(coach.id, "POST", `/groups/${groupId}/activity-series`, {
      body: {
        title: "Forever",
        slots: [{ weekday: 1, startTime: "18:00", durationMinutes: 60 }],
        startsOn: "2027-01-01",
        endsOn: "2028-03-01",
      },
    });
    expect(detail(tooLong)).toBe("series_too_long");
    // 02:30 on 28 March 2027 does not exist in Stockholm (a Sunday).
    const missing = await api(coach.id, "POST", `/groups/${groupId}/activity-series/preview`, {
      body: {
        slots: [{ weekday: 7, startTime: "02:30", durationMinutes: 60 }],
        startsOn: "2027-03-22",
        endsOn: "2027-03-31",
      },
    });
    expect(detail(missing)).toBe("nonexistent_local_time");
  });

  it("changes from a date: detached and cancelled sessions keep their changes, deleted ones stay away", async () => {
    const { club, groupId, coach, member } = await team();
    const start = day(8);
    const created = await api(coach.id, "POST", `/groups/${groupId}/activity-series`, {
      body: {
        title: "Träning",
        slots: [{ weekday: isoWeekday(start), startTime: "17:00", durationMinutes: 60 }],
        startsOn: start,
        endsOn: day(8 + 7 * 5),
      },
    });
    const seriesId = created.json<SeriesChangeJson>().series.id;
    const [first, second, third, fourth] = await calendar(coach.id, groupId, day(7), day(50));
    // Detach the second (moved an hour), cancel the third, delete the fourth.
    const moved = await api(coach.id, "PATCH", `/activities/${second!.id}`, {
      body: { startsAt: later(second!.startsAt), endsAt: later(second!.endsAt) },
    });
    expect(moved.json<ActivityJson>()).toMatchObject({ detached: true, sequence: 1 });
    await api(coach.id, "POST", `/activities/${third!.id}/cancel`, {
      body: { reason: "Hall taken" },
    });
    expect((await api(coach.id, "DELETE", `/activities/${fourth!.id}`)).statusCode).toBe(204);
    // A member cannot change anything.
    expect(
      (await api(member.id, "PATCH", `/activity-series/${seriesId}`, { body: { title: "X" } }))
        .statusCode,
    ).toBe(403);

    const changed = await api(coach.id, "PATCH", `/activity-series/${seriesId}`, {
      body: {
        title: "Träning (ny tid)",
        slots: [{ weekday: isoWeekday(start), startTime: "18:00", durationMinutes: 75 }],
      },
    });
    expect(changed.statusCode).toBe(200);
    // Six sessions: the detached second keeps its change, the deleted fourth's date is skipped.
    expect(changed.json<SeriesChangeJson>()).toMatchObject({ created: 0, updated: 4, removed: 0 });
    expect(changed.json<SeriesChangeJson>().series.skipDates).toEqual([
      fourth!.startsAt.slice(0, 10),
    ]);
    const after = await calendar(coach.id, groupId, day(7), day(50));
    const byId = new Map(after.map((a) => [a.id, a]));
    expect(byId.get(first!.id)).toMatchObject({ title: "Träning (ny tid)", sequence: 1 });
    expect(byId.get(second!.id)).toMatchObject({ title: "Träning", detached: true });
    expect(byId.get(third!.id)).toMatchObject({ title: "Träning (ny tid)", status: "cancelled" });
    expect(byId.has(fourth!.id)).toBe(false);
    expect(after).toHaveLength(5);

    // Changes never reach back before today.
    const past = await api(coach.id, "PATCH", `/activity-series/${seriesId}`, {
      body: { from: day(-1), title: "Old" },
    });
    expect(detail(past)).toBe("series_change_in_past");
    expect(await clubAudit(club.id)).toEqual(
      expect.arrayContaining([
        "activity.updated",
        "activity.cancelled",
        "activity.deleted",
        "activity.series.updated",
      ]),
    );
  });

  it("splits at a session: the old series ends the day before, the new one takes the rest", async () => {
    const { groupId, coach } = await team();
    const start = day(8);
    const created = await api(coach.id, "POST", `/groups/${groupId}/activity-series`, {
      body: {
        title: "Höstträning",
        slots: [{ weekday: isoWeekday(start), startTime: "17:00", durationMinutes: 60 }],
        startsOn: start,
        endsOn: day(8 + 7 * 4),
      },
    });
    const seriesId = created.json<SeriesChangeJson>().series.id;
    const sessions = await calendar(coach.id, groupId, day(7), day(50));
    expect(sessions).toHaveLength(5);
    const detachedLater = sessions[3]!;
    await api(coach.id, "PATCH", `/activities/${detachedLater.id}`, {
      body: { title: "Cup prep" },
    });

    const split = await api(coach.id, "POST", `/activity-series/${seriesId}/split`, {
      body: { activityId: sessions[2]!.id, title: "Vinterträning" },
    });
    expect(split.statusCode).toBe(201);
    const result = split.json<SeriesChangeJson>();
    expect(result.series.id).not.toBe(seriesId);
    expect(result.series).toMatchObject({
      startsOn: sessions[2]!.startsAt.slice(0, 10),
      sessions: 3,
    });
    expect(result).toMatchObject({ created: 0, updated: 2, removed: 0 });
    const old = await api(coach.id, "GET", `/activity-series/${seriesId}`);
    expect(old.json()).toMatchObject({ sessions: 2, title: "Höstträning" });

    const after = await calendar(coach.id, groupId, day(7), day(50));
    expect(after.map((a) => a.title)).toEqual([
      "Höstträning",
      "Höstträning",
      "Vinterträning",
      "Cup prep",
      "Vinterträning",
    ]);
    expect(after.slice(2).every((a) => a.seriesId === result.series.id)).toBe(true);
    // The same IDs: nothing was deleted and created again.
    expect(after.map((a) => a.id)).toEqual(sessions.map((a) => a.id));
  });
});

describe("activities and calendars", () => {
  it("joint activities need every group managed, and show once in each calendar", async () => {
    const { club, groupId, coach } = await team("P2012");
    const other = await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" });
    const body = {
      kind: "training",
      title: "Gemensam träning",
      startsAt: `${day(9)}T16:00:00Z`,
      endsAt: `${day(9)}T17:30:00Z`,
      groupIds: [other.id],
    };
    const refused = await api(coach.id, "POST", `/groups/${groupId}/activities`, { body });
    expect(refused.statusCode).toBe(403);
    expect(detail(refused)).toBe("group_not_managed");
    await s.memberships.addToGroup(club.ctx, other.id, coach.id, "assistant_coach");
    const created = await api(coach.id, "POST", `/groups/${groupId}/activities`, { body });
    expect(created.statusCode).toBe(201);
    expect(created.json<ActivityJson>().groups.map((g) => g.name)).toEqual(["F2015", "P2012"]);
    const own = await calendar(coach.id, groupId, day(8), day(10));
    const theirs = await calendar(club.manager.id, other.id, day(8), day(10));
    expect(own.map((a) => a.id)).toEqual([created.json<ActivityJson>().id]);
    expect(theirs.map((a) => a.id)).toEqual([created.json<ActivityJson>().id]);
    const clubWide = await api(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/activities?${range(day(8), day(10))}`,
    );
    expect(clubWide.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("shows leader notes and the leaders only as allowed, and refuses long ranges", async () => {
    const { groupId, coach, member } = await team();
    const created = await api(coach.id, "POST", `/groups/${groupId}/activities`, {
      body: {
        kind: "match",
        title: "Seriematch",
        opponent: "Fjordvik IL",
        homeAway: "away",
        startsAt: `${day(10)}T10:00:00Z`,
        endsAt: `${day(10)}T11:30:00Z`,
        leaderNotes: "Bring the first-aid kit",
      },
    });
    const id = created.json<ActivityJson>().id;
    const asMember = await api(member.id, "GET", `/activities/${id}`);
    expect(asMember.statusCode).toBe(200);
    const json = asMember.json<ActivityJson & { leaders: { id: string }[] }>();
    expect(json.canManage).toBe(false);
    expect(json).not.toHaveProperty("leaderNotes");
    expect(json.leaders.map((l) => l.id)).toEqual([coach.id]);
    const asCoach = await api(coach.id, "GET", `/activities/${id}`);
    expect(asCoach.json<ActivityJson>().leaderNotes).toBe("Bring the first-aid kit");

    const long = await api(
      member.id,
      "GET",
      `/groups/${groupId}/activities?${range(day(0), day(500))}`,
    );
    expect(detail(long)).toBe("range_too_long");
  });

  it("finds double bookings, and a renamed location shows in calendars at once", async () => {
    const { club, groupId, coach } = await team();
    const hall = await api(club.manager.id, "POST", `/clubs/${club.id}/locations`, {
      body: { name: "Norrbackahallen", city: "Norrbacka", latitude: 63.1, longitude: 17.2 },
    });
    expect(hall.statusCode).toBe(201);
    const location = hall.json<{ id: string; mapUrl: string }>();
    expect(location.mapUrl).toContain("openstreetmap.org");
    const duplicate = await api(club.manager.id, "POST", `/clubs/${club.id}/locations`, {
      body: { name: "norrbackahallen" },
    });
    expect(detail(duplicate)).toBe("location_name_taken");

    const at = (hour: number) => ({
      kind: "training",
      title: `Pass ${hour}`,
      startsAt: `${day(11)}T${hour}:00:00Z`,
      endsAt: `${day(11)}T${hour + 1}:30:00Z`,
      locationId: location.id,
    });
    await api(coach.id, "POST", `/groups/${groupId}/activities`, { body: at(15) });
    await api(coach.id, "POST", `/groups/${groupId}/activities`, { body: at(16) });
    await api(coach.id, "POST", `/groups/${groupId}/activities`, { body: at(18) });
    const conflicts = await api(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/locations/${location.id}/conflicts?${range(day(10), day(12))}`,
    );
    expect(
      conflicts
        .json<{ conflicts: { first: { title: string }; second: { title: string } }[] }>()
        .conflicts.map((c) => [c.first.title, c.second.title]),
    ).toEqual([["Pass 15", "Pass 16"]]);

    await api(club.manager.id, "PATCH", `/clubs/${club.id}/locations/${location.id}`, {
      body: { name: "Norrbacka sporthall" },
    });
    const schedule = await api(coach.id, "GET", `/me/schedule?${range(day(10), day(12))}`);
    expect(schedule.json<ScheduleJson>().items.map((i) => i.place)).toEqual([
      "Norrbacka sporthall",
      "Norrbacka sporthall",
      "Norrbacka sporthall",
    ]);
    // Archived locations are not offered for new activities.
    await api(club.manager.id, "PATCH", `/clubs/${club.id}/locations/${location.id}`, {
      body: { archived: true },
    });
    expect(
      detail(await api(coach.id, "POST", `/groups/${groupId}/activities`, { body: at(12) })),
    ).toBe("location_archived");
  });

  it("refuses changes in a read-only club, but still shows the calendar", async () => {
    const { club, groupId, coach } = await team();
    await t.query("admin", "UPDATE clubs SET access_state = 'read_only' WHERE id = $1", [club.id]);
    const res = await api(coach.id, "POST", `/groups/${groupId}/activities`, {
      body: {
        kind: "meeting",
        title: "Föräldramöte",
        startsAt: `${day(5)}T17:00:00Z`,
        endsAt: `${day(5)}T18:00:00Z`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(
      (await api(coach.id, "GET", `/groups/${groupId}/activities?${range(day(0), day(30))}`))
        .statusCode,
    ).toBe(200);
  });
});

describe("my schedule", () => {
  it("covers my wards across clubs, never wards without view_schedule, and follows group changes at once", async () => {
    const a = await team("F2016");
    const b = await team("Simning");
    const parent = await buildPerson(s);
    const { child } = await s.guardianships.addChild(actor(parent.id), {
      givenName: "Liv",
      familyName: parent.familyName,
      birthDate: "2016-05-01",
    });
    const contact = await buildPerson(s);
    await s.guardianships.addGuardian(actor(parent.id), {
      guardianPersonId: contact.id,
      wardPersonId: child.id,
      kind: "contact_person",
      rights: ["receive_messages"],
    });
    for (const t2 of [a, b]) {
      await s.memberships.addMember(t2.club.ctx, child.id);
      await s.memberships.addToGroup(t2.club.ctx, t2.groupId, child.id);
    }
    const add = (t2: typeof a, title: string, offset: number) =>
      api(t2.coach.id, "POST", `/groups/${t2.groupId}/activities`, {
        body: {
          kind: "training",
          title,
          startsAt: `${day(offset)}T15:00:00Z`,
          endsAt: `${day(offset)}T16:00:00Z`,
        },
      });
    await add(a, "Fotboll", 3);
    await add(b, "Simning", 4);
    const window = range(day(1), day(20));

    const mine = (await api(parent.id, "GET", `/me/schedule?${window}`)).json<ScheduleJson>();
    expect(mine.items.map((i) => i.title)).toEqual(["Fotboll", "Simning"]);
    expect(mine.items.map((i) => i.club.id)).toEqual([a.club.id, b.club.id]);
    expect(mine.items.every((i) => i.people.map((p) => p.id).join() === child.id)).toBe(true);
    expect(mine.people.map((p) => p.id).sort()).toEqual([parent.id, child.id].sort());
    // One club only; one person only.
    const onlyB = (
      await api(parent.id, "GET", `/me/schedule?${window}&clubId=${b.club.id}`)
    ).json<ScheduleJson>();
    expect(onlyB.items.map((i) => i.title)).toEqual(["Simning"]);
    const onlyMe = (
      await api(parent.id, "GET", `/me/schedule?${window}&personId=${parent.id}`)
    ).json<ScheduleJson>();
    expect(onlyMe.items).toEqual([]);

    // The contact person (messages only) sees no schedule and cannot ask for the child's.
    const contactView = (
      await api(contact.id, "GET", `/me/schedule?${window}`)
    ).json<ScheduleJson>();
    expect(contactView.items).toEqual([]);
    expect(contactView.people.map((p) => p.id)).toEqual([contact.id]);
    expect(
      (await api(contact.id, "GET", `/me/schedule?${window}&personId=${child.id}`)).statusCode,
    ).toBe(404);

    // Viewing as the child: the child's schedule only.
    const asChild = await api(parent.id, "GET", `/me/schedule?${window}`, {
      onBehalfOf: child.id,
    });
    expect(asChild.json<ScheduleJson>().items).toHaveLength(2);

    // Leaving the swimming group removes its activities at once.
    const memberships = await s.memberships.groupMembers(b.club.ctx, b.groupId);
    const childMembership = memberships.find((m) => m.personId === child.id)!;
    await s.memberships.endGroupMembership(b.club.ctx, childMembership.id);
    const afterLeaving = (
      await api(parent.id, "GET", `/me/schedule?${window}`)
    ).json<ScheduleJson>();
    expect(afterLeaving.items.map((i) => i.title)).toEqual(["Fotboll"]);

    // Cancelled activities stay, marked; changedSince marks what changed.
    const since = new Date().toISOString();
    const [football] = await calendar(a.coach.id, a.groupId, day(1), day(20));
    await api(a.coach.id, "POST", `/activities/${football!.id}/cancel`, { body: {} });
    const marked = (
      await api(
        parent.id,
        "GET",
        `/me/schedule?${window}&changedSince=${encodeURIComponent(since)}`,
      )
    ).json<ScheduleJson>();
    expect(marked.items[0]).toMatchObject({ status: "cancelled", changed: true });
  });

  it("pages with a cursor and shows a joint activity once", async () => {
    const { club, groupId, coach, member } = await team();
    const other = await s.groups.createGroup(club.ctx, {
      name: "Målvakter",
      kind: "training_group",
    });
    await s.memberships.addToGroup(club.ctx, other.id, member.id);
    await s.memberships.addToGroup(club.ctx, other.id, coach.id, "head_coach");
    for (let i = 0; i < 5; i++) {
      await api(coach.id, "POST", `/groups/${groupId}/activities`, {
        body: {
          kind: "training",
          title: `Pass ${i}`,
          startsAt: `${day(3 + i)}T15:00:00Z`,
          endsAt: `${day(3 + i)}T16:00:00Z`,
          groupIds: i === 0 ? [other.id] : [],
        },
      });
    }
    const window = range(day(1), day(20));
    const first = (
      await api(member.id, "GET", `/me/schedule?${window}&limit=3`)
    ).json<ScheduleJson>();
    expect(first.items.map((i) => i.title)).toEqual(["Pass 0", "Pass 1", "Pass 2"]);
    expect(first.items[0]!.groups).toHaveLength(2);
    const rest = (
      await api(member.id, "GET", `/me/schedule?${window}&limit=3&cursor=${first.nextCursor}`)
    ).json<ScheduleJson>();
    expect(rest.items.map((i) => i.title)).toEqual(["Pass 3", "Pass 4"]);
    expect(rest.nextCursor).toBeNull();
  });
});
