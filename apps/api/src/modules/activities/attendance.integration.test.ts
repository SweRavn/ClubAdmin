// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance through the HTTP API (P1.5, ADR 0035): a
// guardian answers for a child, a teen for themselves, a relative without
// sign_up cannot; the deadline and cancellations; what leaders and members
// see (protected members only counted); attendance with offline ordering,
// idempotent resends, the lock and corrections; the roster by date and
// guests; deleting and series changes keep answered sessions; "My schedule"
// with answers; a group's summary with the LOK-stöd hints; call-ups (#19).

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

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

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
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;
async function audit(clubId: string): Promise<string[]> {
  const { rows } = await t.query<{ action: string }>(
    "admin",
    "SELECT action FROM audit.events WHERE club_id = $1 ORDER BY created_at, id",
    [clubId],
  );
  return rows.map((r) => r.action);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface Summary {
  responseMode: string;
  open: boolean;
  deadlinePassed: boolean;
  counts: { attending: number; notAttending: number; notAnswered: number; roster: number };
  attending: { id: string }[] | null;
  mine: {
    person: { id: string };
    status: string | null;
    note?: string | null;
    respondedBy: { id: string } | null;
    canRespond: boolean;
  }[];
}
interface AttendanceJson {
  locked: boolean;
  open: boolean;
  canRecord: boolean;
  canCorrect: boolean;
  participants: {
    person: { id: string; protected: boolean };
    status: string | null;
    suggested: string | null;
    guest: boolean;
  }[];
  leaders: { person: { id: string }; status: string | null }[];
  hasProtected: boolean;
  hints: { scheme: string; code: string }[];
}

interface Team {
  club: BuiltClub;
  groupId: string;
  coach: BuiltPerson;
  /** An adult member with their own login. */
  member: BuiltPerson;
  /** A protected adult member. */
  hidden: BuiltPerson;
  parent: BuiltPerson;
  child: { id: string };
  /** The child's grandmother: view_schedule only. */
  grandmother: BuiltPerson;
}

/** A club with a team: a coach, a member, a protected member, and a child with a parent and a relative. */
async function team(): Promise<Team> {
  const club = await buildClub(s);
  const group = await s.groups.createGroup(club.ctx, { name: "F2016", kind: "team" });
  const join = async (fn: "member" | "head_coach", overrides = {}) => {
    const person = await buildPerson(s, overrides);
    await s.memberships.addMember(club.ctx, person.id);
    await s.memberships.addToGroup(club.ctx, group.id, person.id, fn);
    return person;
  };
  const coach = await join("head_coach");
  const member = await join("member", { birthDate: "2010-02-01" });
  const hidden = await join("member", { protectedIdentity: true, birthDate: "2011-03-01" });
  const parent = await buildPerson(s);
  const { child } = await s.guardianships.addChild(actor(parent.id), {
    givenName: "Liv",
    familyName: parent.familyName,
    birthDate: "2016-05-01",
  });
  await s.memberships.addMember(club.ctx, child.id);
  await s.memberships.addToGroup(club.ctx, group.id, child.id);
  const grandmother = await buildPerson(s);
  await s.guardianships.addGuardian(actor(parent.id), {
    guardianPersonId: grandmother.id,
    wardPersonId: child.id,
    kind: "relative",
  });
  return { club, groupId: group.id, coach, member, hidden, parent, child, grandmother };
}

/** Moves the team's memberships back in time (so past activities have them on the roster). */
async function backdate(groupId: string, days = 120): Promise<void> {
  await t.query(
    "admin",
    `UPDATE group_memberships SET valid_from = now() - make_interval(days => $2) WHERE group_id = $1`,
    [groupId, days],
  );
}

async function activity(
  x: Team,
  body: Record<string, unknown> & { startsAt: string; endsAt: string },
): Promise<string> {
  const res = await api(x.coach.id, "POST", `/groups/${x.groupId}/activities`, {
    body: { kind: "match", title: "Match", ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const summary = async (personId: string, activityId: string) => {
  const res = await api(personId, "GET", `/activities/${activityId}/responses/summary`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Summary>();
};

describe("responses", () => {
  it("a guardian answers for a child, a member for themselves; a relative without sign_up cannot", async () => {
    const x = await team();
    const id = await activity(x, { startsAt: at(5 * DAY), endsAt: at(5 * DAY + 2 * HOUR) });
    expect((await summary(x.parent.id, id)).mine).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ id: x.child.id }) as unknown,
        status: null,
        canRespond: true,
      }),
    ]);

    const answered = await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "attending" },
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json<Summary>()).toMatchObject({
      responseMode: "requested",
      counts: { attending: 1, notAttending: 0, notAnswered: 2, roster: 3 },
      mine: [{ status: "attending", respondedBy: { id: x.parent.id } }],
    });
    const own = await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
      body: { status: "not_attending", note: "Away" },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<Summary>().mine).toEqual([
      expect.objectContaining({ status: "not_attending", note: "Away" }),
    ]);

    // The grandmother sees the schedule (view_schedule) but cannot answer.
    const relative = await api(
      x.grandmother.id,
      "PUT",
      `/activities/${id}/responses/${x.child.id}`,
      {
        body: { status: "not_attending" },
      },
    );
    expect(relative.statusCode).toBe(403);
    // The coach is not on the roster as a participant; nobody answers for strangers.
    const coach = await api(x.coach.id, "PUT", `/activities/${id}/responses/${x.coach.id}`, {
      body: { status: "attending" },
    });
    expect(coach.statusCode).toBe(403);
    const other = await api(x.member.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "attending" },
    });
    expect(other.statusCode).toBe(404);

    // The same answer again changes nothing (offline resend): one audit event each.
    await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "attending" },
    });
    expect((await audit(x.club.id)).filter((a) => a === "activity.response.set")).toHaveLength(2);
    // Acting on behalf of the child works too, and is recorded as on behalf.
    const onBehalf = await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "not_attending", note: "Feber" },
      onBehalfOf: x.child.id,
    });
    expect(onBehalf.statusCode).toBe(200);
    const { rows } = await t.query<{ on_behalf_of_person_id: string | null }>(
      "admin",
      `SELECT on_behalf_of_person_id FROM audit.events
       WHERE club_id = $1 AND action = 'activity.response.set' ORDER BY created_at, id`,
      [x.club.id],
    );
    expect(rows.map((r) => r.on_behalf_of_person_id)).toEqual([x.child.id, null, x.child.id]);
  });

  it("after the deadline only 'not attending'; cancelled and 'none' activities take no answers", async () => {
    const x = await team();
    const id = await activity(x, {
      startsAt: at(2 * DAY),
      endsAt: at(2 * DAY + HOUR),
      respondBy: at(-HOUR),
    });
    const late = await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
      body: { status: "attending" },
    });
    expect([late.statusCode, detail(late)]).toEqual([409, "response_closed"]);
    const sick = await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
      body: { status: "not_attending", note: "Sjuk" },
    });
    expect(sick.statusCode).toBe(200);
    expect(sick.json<Summary>()).toMatchObject({ deadlinePassed: true, open: true });
    const withdraw = await api(x.member.id, "DELETE", `/activities/${id}/responses/${x.member.id}`);
    expect(detail(withdraw)).toBe("response_closed");

    const cancelled = await activity(x, { startsAt: at(3 * DAY), endsAt: at(3 * DAY + HOUR) });
    await api(x.coach.id, "POST", `/activities/${cancelled}/cancel`, { body: {} });
    const refused = await api(
      x.member.id,
      "PUT",
      `/activities/${cancelled}/responses/${x.member.id}`,
      {
        body: { status: "attending" },
      },
    );
    expect(detail(refused)).toBe("activity_cancelled");
    const none = await activity(x, {
      kind: "other",
      startsAt: at(4 * DAY),
      endsAt: at(4 * DAY + HOUR),
    });
    const noAnswers = await api(
      x.member.id,
      "PUT",
      `/activities/${none}/responses/${x.member.id}`,
      {
        body: { status: "attending" },
      },
    );
    expect(detail(noAnswers)).toBe("response_not_requested");
  });

  it("leaders see names, notes and who has not answered; members only the names they may see", async () => {
    const x = await team();
    const id = await activity(x, { startsAt: at(5 * DAY), endsAt: at(5 * DAY + HOUR) });
    for (const p of [x.member, x.hidden]) {
      await api(p.id, "PUT", `/activities/${id}/responses/${p.id}`, {
        body: { status: "attending" },
      });
    }
    await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "not_attending", note: "Feber" },
    });

    const forMember = await summary(x.member.id, id);
    expect(forMember.counts).toEqual({ attending: 2, notAttending: 1, notAnswered: 0, roster: 3 });
    // The protected member is counted, never named, for other members.
    expect(forMember.attending?.map((p) => p.id)).toEqual([x.member.id]);
    // The relative may read the schedule, not the roster: counts only.
    expect((await summary(x.grandmother.id, id)).attending).toBeNull();

    const list = await api(x.coach.id, "GET", `/activities/${id}/responses`);
    expect(list.statusCode).toBe(200);
    const items = list.json<{
      items: {
        person: { id: string; protected: boolean };
        status: string | null;
        note?: string | null;
      }[];
    }>().items;
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.person.id === x.hidden.id)?.person.protected).toBe(true);
    expect(items.find((i) => i.person.id === x.child.id)).toMatchObject({
      status: "not_attending",
      note: "Feber",
    });
    expect((await api(x.member.id, "GET", `/activities/${id}/responses`)).statusCode).toBe(403);
    const notAnswered = await api(x.coach.id, "GET", `/activities/${id}/responses?status=none`);
    expect(notAnswered.json<{ items: unknown[] }>().items).toEqual([]);

    // The group calendar shows the counts to those who manage the activity.
    const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(10 * DAY))}`;
    const calendar = await api(x.coach.id, "GET", `/groups/${x.groupId}/activities?${range}`);
    expect(calendar.json<{ items: { id: string; responseCounts?: unknown }[] }>().items).toEqual([
      expect.objectContaining({
        id,
        responseCounts: { attending: 2, notAttending: 1, notAnswered: 0, roster: 3 },
      }),
    ]);
    expect(calendar.json<{ canReadAttendance: boolean }>().canReadAttendance).toBe(true);
    const forMemberCalendar = await api(
      x.member.id,
      "GET",
      `/groups/${x.groupId}/activities?${range}`,
    );
    expect(
      forMemberCalendar.json<{ items: { responseCounts?: unknown }[] }>().items[0]?.responseCounts,
    ).toBeUndefined();
    expect(forMemberCalendar.json<{ canReadAttendance: boolean }>().canReadAttendance).toBe(false);
  });

  it("'My schedule' has each person's answer and whether the viewer may give it", async () => {
    const x = await team();
    const id = await activity(x, { startsAt: at(5 * DAY), endsAt: at(5 * DAY + HOUR) });
    await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      body: { status: "attending" },
    });
    const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(10 * DAY))}`;
    type Entry = {
      activityId: string;
      responses: { personId: string; status: string | null; canRespond: boolean }[];
    };
    const forParent = (await api(x.parent.id, "GET", `/me/schedule?${range}`)).json<{
      items: Entry[];
    }>();
    expect(forParent.items.find((e) => e.activityId === id)?.responses).toEqual([
      { personId: x.child.id, status: "attending", canRespond: true },
    ]);
    const forGrandmother = (await api(x.grandmother.id, "GET", `/me/schedule?${range}`)).json<{
      items: Entry[];
    }>();
    expect(forGrandmother.items.find((e) => e.activityId === id)?.responses).toEqual([
      { personId: x.child.id, status: "attending", canRespond: false },
    ]);
    const forCoach = (await api(x.coach.id, "GET", `/me/schedule?${range}`)).json<{
      items: Entry[];
    }>();
    expect(forCoach.items.find((e) => e.activityId === id)?.responses).toEqual([
      { personId: x.coach.id, status: null, canRespond: false },
    ]);
  });
});

describe("call-ups", () => {
  it("only those called up answer, are counted and have it in their schedule", async () => {
    const x = await team();
    const id = await activity(x, { startsAt: at(5 * DAY), endsAt: at(5 * DAY + HOUR) });
    // The member answered before the call-up.
    expect(
      (
        await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
          body: { status: "attending" },
        })
      ).statusCode,
    ).toBe(200);
    type InviteesJson = {
      inviteesOnly: boolean;
      candidates: { person: { id: string }; invited: boolean }[];
      invitedCount: number;
    };
    const before = await api(x.coach.id, "GET", `/activities/${id}/invitees`);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json<InviteesJson>()).toMatchObject({ inviteesOnly: false, invitedCount: 0 });
    expect(
      before
        .json<InviteesJson>()
        .candidates.map((c) => c.person.id)
        .sort(),
    ).toEqual([x.member.id, x.hidden.id, x.child.id].sort());

    // Someone outside the group cannot be called up.
    const stranger = await buildPerson(s);
    const refused = await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      body: { inviteesOnly: true, personIds: [stranger.id] },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toBe("not_on_roster");

    const set = await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      body: { inviteesOnly: true, personIds: [x.child.id, x.hidden.id] },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<InviteesJson>()).toMatchObject({ inviteesOnly: true, invitedCount: 2 });
    // The same again changes nothing.
    await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      body: { inviteesOnly: true, personIds: [x.hidden.id, x.child.id] },
    });
    expect((await audit(x.club.id)).filter((a) => a === "activity.invitees.changed")).toHaveLength(
      1,
    );

    // The member's answer stays but is not counted; they can no longer answer.
    expect((await summary(x.coach.id, id)).counts).toEqual({
      attending: 0,
      notAttending: 0,
      notAnswered: 2,
      roster: 2,
    });
    const late = await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
      body: { status: "not_attending" },
    });
    expect(late.statusCode).toBe(409);
    expect(detail(late)).toBe("not_on_roster");
    expect(
      (
        await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
          body: { status: "attending" },
        })
      ).statusCode,
    ).toBe(200);

    // "My schedule": the member no longer has it; the child's parent and the coach do.
    const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(10 * DAY))}`;
    const has = async (personId: string) =>
      (await api(personId, "GET", `/me/schedule?${range}`))
        .json<{ items: { activityId: string }[] }>()
        .items.some((e) => e.activityId === id);
    expect(await has(x.member.id)).toBe(false);
    expect(await has(x.parent.id)).toBe(true);
    expect(await has(x.coach.id)).toBe(true);

    // The activity says so; the group calendar counts only those called up.
    const detailRes = await api(x.member.id, "GET", `/activities/${id}`);
    expect(detailRes.json<{ inviteesOnly: boolean }>().inviteesOnly).toBe(true);

    // The whole group again: the member's earlier answer counts again.
    const all = await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      body: { inviteesOnly: false, personIds: [] },
    });
    expect(all.json<InviteesJson>()).toMatchObject({ inviteesOnly: false, invitedCount: 0 });
    expect((await summary(x.coach.id, id)).counts).toEqual({
      attending: 2,
      notAttending: 0,
      notAnswered: 1,
      roster: 3,
    });
    expect(await has(x.member.id)).toBe(true);
  });

  it("the attendance roster is those called up; others come as guests; past activities are closed", async () => {
    const x = await team();
    await backdate(x.groupId);
    const id = await activity(x, { startsAt: at(30 * 60_000), endsAt: at(2 * HOUR) });
    await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      body: { inviteesOnly: true, personIds: [x.child.id] },
    });
    const sheet = (
      await api(x.coach.id, "GET", `/activities/${id}/attendance`)
    ).json<AttendanceJson>();
    expect(sheet.participants.map((p) => p.person.id)).toEqual([x.child.id]);
    expect(sheet.leaders.map((l) => l.person.id)).toEqual([x.coach.id]);
    const recorded = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "present" }] },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(
      recorded
        .json<{ attendance: AttendanceJson }>()
        .attendance.participants.find((p) => p.person.id === x.member.id)?.guest,
    ).toBe(true);

    const past = await activity(x, { startsAt: at(-3 * HOUR), endsAt: at(-2 * HOUR) });
    const closed = await api(x.coach.id, "PUT", `/activities/${past}/invitees`, {
      body: { inviteesOnly: true, personIds: [x.child.id] },
    });
    expect(closed.statusCode).toBe(409);
    expect(detail(closed)).toBe("activity_ended");
  });
});

describe("attendance", () => {
  it("leaders record marks, prefilled from answers; offline marks are ordered by device time", async () => {
    const x = await team();
    const id = await activity(x, {
      kind: "training",
      title: "Träning",
      startsAt: at(-2 * HOUR),
      endsAt: at(-HOUR),
    });
    await backdate(x.groupId);
    // Answers given while it was coming (written directly: it has started now).
    await t.query(
      "admin",
      `INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
       VALUES ($1, $2, $3, 'attending', $3), ($1, $2, $4, 'not_attending', $5)`,
      [x.club.id, id, x.member.id, x.child.id, x.parent.id],
    );
    const before = await api(x.coach.id, "GET", `/activities/${id}/attendance`);
    expect(before.statusCode, before.body).toBe(200);
    const sheet = before.json<AttendanceJson>();
    expect(sheet).toMatchObject({ open: true, locked: false, canRecord: true, hasProtected: true });
    expect(Object.fromEntries(sheet.participants.map((p) => [p.person.id, p.suggested]))).toEqual({
      [x.member.id]: "present",
      [x.child.id]: "excused",
      [x.hidden.id]: null,
    });
    expect(sheet.leaders.map((l) => l.person.id)).toEqual([x.coach.id]);
    expect((await api(x.member.id, "GET", `/activities/${id}/attendance`)).statusCode).toBe(403);

    const later = at(-10 * 60_000);
    const earlier = at(-30 * 60_000);
    const first = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: {
        marks: [
          { personId: x.member.id, status: "present", recordedAt: later },
          { personId: x.child.id, status: "excused", recordedAt: later },
          { personId: x.coach.id, status: "present", role: "leader", recordedAt: later },
        ],
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    // An older mark (from a phone that was offline longer) does not overwrite a newer one.
    const stale = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: {
        marks: [
          { personId: x.member.id, status: "absent", recordedAt: earlier },
          { personId: x.hidden.id, status: "absent", recordedAt: earlier },
        ],
      },
    });
    const result = stale.json<{ attendance: AttendanceJson; stale: string[] }>();
    expect(result.stale).toEqual([x.member.id]);
    const status = Object.fromEntries(
      result.attendance.participants.map((p) => [p.person.id, p.status]),
    );
    expect(status).toEqual({
      [x.member.id]: "present",
      [x.child.id]: "excused",
      [x.hidden.id]: "absent",
    });
    // Sending the same marks again records nothing.
    await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "present", recordedAt: later }] },
    });
    expect((await audit(x.club.id)).filter((a) => a === "attendance.recorded")).toHaveLength(2);
    // A time far ahead of the server's is refused.
    const future = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "absent", recordedAt: at(HOUR) }] },
    });
    expect(detail(future)).toBe("recorded_at_out_of_range");
  });

  it("guests must be club members; the roster follows membership on the activity's date", async () => {
    const x = await team();
    const id = await activity(x, {
      kind: "training",
      startsAt: at(-3 * DAY),
      endsAt: at(-3 * DAY + HOUR),
    });
    // Memberships from today: nobody but the guest is on a roster three days ago.
    const empty = (
      await api(x.coach.id, "GET", `/activities/${id}/attendance`)
    ).json<AttendanceJson>();
    expect(empty.participants).toEqual([]);
    await backdate(x.groupId);
    const sheet = (
      await api(x.coach.id, "GET", `/activities/${id}/attendance`)
    ).json<AttendanceJson>();
    expect(sheet.participants).toHaveLength(3);

    const otherMember = await buildPerson(s);
    await s.memberships.addMember(x.club.ctx, otherMember.id);
    const guest = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: otherMember.id, status: "present" }] },
    });
    expect(guest.statusCode, guest.body).toBe(200);
    expect(
      guest
        .json<{ attendance: AttendanceJson }>()
        .attendance.participants.find((p) => p.person.id === otherMember.id),
    ).toMatchObject({ guest: true, status: "present" });
    const stranger = await buildPerson(s);
    const refused = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: stranger.id, status: "present" }] },
    });
    expect(detail(refused)).toBe("not_a_club_member");

    // Not yet open (more than an hour before the start).
    const coming = await activity(x, { startsAt: at(DAY), endsAt: at(DAY + HOUR) });
    const early = await api(x.coach.id, "PUT", `/activities/${coming}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "present" }] },
    });
    expect(detail(early)).toBe("activity_not_started");
  });

  it("after the lock leaders read only; managers and registrars correct with a reason", async () => {
    const x = await team();
    const registrar = await buildPerson(s);
    await s.memberships.addMember(x.club.ctx, registrar.id);
    await s.roles.assignRole(x.club.ctx, registrar.id, "registrar");
    const id = await activity(x, {
      kind: "training",
      startsAt: at(-40 * DAY),
      endsAt: at(-40 * DAY + HOUR),
    });
    await backdate(x.groupId);
    const sheet = (
      await api(x.coach.id, "GET", `/activities/${id}/attendance`)
    ).json<AttendanceJson>();
    expect(sheet).toMatchObject({ locked: true, canRecord: false, canCorrect: false });
    const leader = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "present" }] },
    });
    expect(detail(leader)).toBe("attendance_locked");
    const noReason = await api(registrar.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "present" }] },
    });
    expect(detail(noReason)).toBe("correction_reason_required");
    const corrected = await api(registrar.id, "PUT", `/activities/${id}/attendance`, {
      body: {
        marks: [{ personId: x.member.id, status: "present" }],
        correctedReason: "Fel markering",
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(
      (await api(registrar.id, "GET", `/activities/${id}/attendance`)).json<AttendanceJson>(),
    ).toMatchObject({
      canCorrect: true,
    });
    const again = await api(x.club.manager.id, "PUT", `/activities/${id}/attendance`, {
      body: { marks: [{ personId: x.member.id, status: "absent" }], correctedReason: "Fel igen" },
    });
    expect(again.statusCode).toBe(200);
    expect((await audit(x.club.id)).filter((a) => a.startsWith("attendance."))).toEqual([
      "attendance.corrected",
      "attendance.corrected",
    ]);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM history.record_changes WHERE table_name = 'public.attendance_records'`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("a group's summary counts sessions and marks per member, with the LOK-stöd hints", async () => {
    const x = await team();
    const short = await activity(x, {
      kind: "training",
      title: "Kort",
      startsAt: at(-10 * DAY),
      endsAt: at(-10 * DAY + 30 * 60_000),
    });
    const full = await activity(x, {
      kind: "training",
      title: "Lång",
      startsAt: at(-5 * DAY),
      endsAt: at(-5 * DAY + 90 * 60_000),
    });
    await backdate(x.groupId);
    for (const id of [short, full]) {
      const res = await api(x.coach.id, "PUT", `/activities/${id}/attendance`, {
        body: {
          marks: [
            { personId: x.member.id, status: "present" },
            { personId: x.hidden.id, status: "present" },
            { personId: x.child.id, status: id === full ? "present" : "absent" },
            { personId: x.coach.id, status: "present", role: "leader" },
          ],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const range = `from=${encodeURIComponent(at(-30 * DAY))}&to=${encodeURIComponent(at(0))}`;
    const res = await api(x.coach.id, "GET", `/groups/${x.groupId}/attendance?${range}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      sessions: {
        activityId: string;
        present: number;
        leadersPresent: number;
        hints: { code: string }[];
      }[];
      members: {
        person: { id: string };
        sessions: number;
        present: number;
        absent: number;
        rate: number | null;
      }[];
    }>();
    expect(body.sessions).toEqual([
      expect.objectContaining({
        activityId: short,
        present: 2,
        leadersPresent: 1,
        hints: [
          { scheme: "lok", code: "too_short" },
          { scheme: "lok", code: "too_few_participants" },
        ],
      }),
      expect.objectContaining({ activityId: full, present: 3, hints: [] }),
    ]);
    expect(body.members.find((m) => m.person.id === x.child.id)).toMatchObject({
      sessions: 2,
      present: 1,
      absent: 1,
      rate: 0.5,
    });
    expect(
      (await api(x.member.id, "GET", `/groups/${x.groupId}/attendance?${range}`)).statusCode,
    ).toBe(403);
  });
});

describe("activities with answers", () => {
  it("are not deleted; a series change cancels the sessions it drops instead", async () => {
    const x = await team();
    const id = await activity(x, { startsAt: at(5 * DAY), endsAt: at(5 * DAY + HOUR) });
    await api(x.member.id, "PUT", `/activities/${id}/responses/${x.member.id}`, {
      body: { status: "attending" },
    });
    const deleted = await api(x.coach.id, "DELETE", `/activities/${id}`);
    expect([deleted.statusCode, detail(deleted)]).toEqual([409, "activity_has_responses"]);

    const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    const start = day(7);
    const created = await api(x.coach.id, "POST", `/groups/${x.groupId}/activity-series`, {
      body: {
        title: "Träning",
        slots: [{ weekday: weekday(start), startTime: "18:00", durationMinutes: 60 }],
        startsOn: start,
        endsOn: day(21),
        respondByMinutes: 120,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const seriesId = created.json<{ series: { id: string; responseMode: string } }>().series.id;
    expect(created.json<{ series: { responseMode: string } }>().series.responseMode).toBe(
      "optional",
    );
    const range = `from=${encodeURIComponent(at(6 * DAY))}&to=${encodeURIComponent(at(30 * DAY))}`;
    const sessions = (await api(x.coach.id, "GET", `/groups/${x.groupId}/activities?${range}`))
      .json<{
        items: {
          id: string;
          seriesId: string | null;
          startsAt: string;
          respondBy: string | null;
        }[];
      }>()
      .items.filter((a) => a.seriesId === seriesId);
    expect(sessions).toHaveLength(3);
    expect(Date.parse(sessions[0]!.startsAt) - Date.parse(sessions[0]!.respondBy!)).toBe(2 * HOUR);
    const answered = sessions[1]!.id;
    await api(x.member.id, "PUT", `/activities/${answered}/responses/${x.member.id}`, {
      body: { status: "not_attending" },
    });
    // Move the series to another weekday: the answered session stays, cancelled.
    const changed = await api(x.coach.id, "PATCH", `/activity-series/${seriesId}`, {
      body: {
        slots: [{ weekday: (weekday(start) % 7) + 1, startTime: "18:00", durationMinutes: 60 }],
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const kept = await api(x.coach.id, "GET", `/activities/${answered}`);
    expect(kept.json<{ status: string }>().status).toBe("cancelled");
    expect((await api(x.coach.id, "GET", `/activities/${sessions[0]!.id}`)).statusCode).toBe(404);
  });
});
