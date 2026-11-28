// SPDX-License-Identifier: AGPL-3.0-only
// Call-ups across groups (P2.10, ADR 0056 as amended 2026-11-28) through the
// HTTP API: permanent guests take part but take no place; ad hoc guests from
// the whole club read and answer the activity; changes are silent until the
// call-up goes out, after which removing someone is a revocation with a
// reason that the person sees; not after the start; a series' call-up with
// per-session exceptions that follow the series and its split.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
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

async function api(personId: string, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId, { mfa: false })}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface InviteesJson {
  inviteesOnly: boolean;
  candidates: { person: { id: string }; invited: boolean; guest?: boolean }[];
  others?: { person: { id: string }; groups: { id: string; name: string }[] }[];
  callUpSentAt?: string | null;
  announced?: boolean;
  revocations?: { personId: string; reason: string; revokedBy?: { id: string } }[];
}

interface Club {
  club: BuiltClub;
  team: string;
  other: string;
  coach: BuiltPerson;
  member: BuiltPerson;
  parent: BuiltPerson;
  child: { id: string };
  /** A player of the other group (Minivolley) with her own login. */
  wilma: BuiltPerson;
}

async function setup(capacity: number | null = null): Promise<Club> {
  const club = await buildClub(s);
  const team = await s.groups.createGroup(club.ctx, { name: "F2017", kind: "team", capacity });
  const other = await s.groups.createGroup(club.ctx, { name: "Minivolley", kind: "team" });
  const join = async (groupId: string, fn: "member" | "head_coach", overrides = {}) => {
    const person = await buildPerson(s, overrides);
    await s.memberships.addMember(club.ctx, person.id);
    await s.memberships.addToGroup(club.ctx, groupId, person.id, fn);
    return person;
  };
  const coach = await join(team.id, "head_coach");
  const member = await join(team.id, "member", { birthDate: "2009-02-01" });
  const parent = await buildPerson(s);
  const { child } = await s.guardianships.addChild(actor(parent.id), {
    givenName: "Alva",
    familyName: parent.familyName,
    birthDate: "2017-05-01",
  });
  await s.memberships.addMember(club.ctx, child.id);
  await s.memberships.addToGroup(club.ctx, team.id, child.id);
  const wilma = await join(other.id, "member", { givenName: "Wilma", birthDate: "2008-03-01" });
  return { club, team: team.id, other: other.id, coach, member, parent, child, wilma };
}

async function activity(x: Club, startsIn: number): Promise<string> {
  const res = await api(x.coach.id, "POST", `/groups/${x.team}/activities`, {
    kind: "training",
    title: "Träning",
    startsAt: at(startsIn),
    endsAt: at(startsIn + HOUR),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/** The call-up went out an hour ago (saved inside the default lead, grace over). */
async function sentAnHourAgo(activityId: string): Promise<void> {
  await t.query(
    "admin",
    "UPDATE activities SET created_at = now() - interval '1 hour' WHERE id = $1",
    [activityId],
  );
}

async function outbox(type: string, key: string, value: string): Promise<unknown[]> {
  const { rows } = await t.query<{ payload: unknown }>(
    "admin",
    `SELECT payload FROM outbox.events WHERE type = $1 AND (payload->>$2 = $3 OR payload->$2 ? $3)
     ORDER BY id`,
    [type, key, value],
  );
  return rows.map((r) => r.payload);
}

describe("guests", () => {
  it("a permanent guest takes part, is marked as a guest and takes no place", async () => {
    const x = await setup(2);
    const { rows } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM roles WHERE club_id = $1 AND guest AND template_key = 'guest_player'",
      [x.club.id],
    );
    const guestRole = rows[0]!.id;
    // F2017 is full (two players); a guest needs no place.
    const added = await api(x.club.manager.id, "POST", `/groups/${x.team}/members`, {
      personId: x.wilma.id,
      roleId: guestRole,
    });
    expect(added.statusCode, added.body).toBe(201);
    const places = await t.query<{ occupied: number }>(
      "admin",
      "SELECT occupied FROM app.group_places($1)",
      [x.team],
    );
    expect(places.rows[0]!.occupied).toBe(2);
    const members = await api(x.coach.id, "GET", `/groups/${x.team}/members`);
    const wilma = members
      .json<{ items: { person: { id: string }; guest?: boolean }[] }>()
      .items.find((m) => m.person.id === x.wilma.id);
    expect(wilma?.guest).toBe(true);

    // She is on the roster as a guest and answers.
    const id = await activity(x, 5 * DAY);
    const answered = await api(x.wilma.id, "PUT", `/activities/${id}/responses/${x.wilma.id}`, {
      status: "attending",
    });
    expect(answered.statusCode, answered.body).toBe(200);
    const invitees = (
      await api(x.coach.id, "GET", `/activities/${id}/invitees`)
    ).json<InviteesJson>();
    expect(invitees.candidates.find((c) => c.person.id === x.wilma.id)?.guest).toBe(true);
    // Not a player for duty quotas (P2.6): the group's players are the two.
    const players = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM group_memberships WHERE group_id = $1 AND participates AND NOT guest AND valid_to IS NULL",
      [x.team],
    );
    expect(players.rows[0]!.n).toBe(2);
  });

  it("an ad hoc guest from another group is found, called up, reads and answers", async () => {
    const x = await setup();
    const id = await activity(x, 5 * DAY);
    const found = (
      await api(x.coach.id, "GET", `/activities/${id}/invitees?q=wilm`)
    ).json<InviteesJson>();
    expect(found.others?.map((o) => o.person.id)).toEqual([x.wilma.id]);
    expect(found.others?.[0]?.groups.map((g) => g.name)).toEqual(["Minivolley"]);
    // Before she is called up she cannot see the activity.
    expect((await api(x.wilma.id, "GET", `/activities/${id}`)).statusCode).toBe(404);

    const set = await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      inviteesOnly: true,
      personIds: [x.member.id, x.child.id, x.wilma.id],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(
      set.json<InviteesJson>().candidates.find((c) => c.person.id === x.wilma.id),
    ).toMatchObject({ invited: true, guest: true });
    expect((await api(x.wilma.id, "GET", `/activities/${id}`)).statusCode).toBe(200);
    const answered = await api(x.wilma.id, "PUT", `/activities/${id}/responses/${x.wilma.id}`, {
      status: "attending",
    });
    expect(answered.statusCode, answered.body).toBe(200);
    const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(10 * DAY))}`;
    const schedule = await api(x.wilma.id, "GET", `/me/schedule?${range}`);
    expect(
      schedule.json<{ items: { activityId: string }[] }>().items.map((e) => e.activityId),
    ).toContain(id);
    // A leader of the group is not a player to call up.
    const leader = await api(x.coach.id, "PUT", `/activities/${id}/invitees/${x.coach.id}`, {
      calledUp: true,
    });
    expect(leader.statusCode).toBe(400);
    expect(detail(leader)).toBe("not_callable");
  });
});

describe("when a call-up goes out", () => {
  it("is silent before it goes out: no notices, no reason", async () => {
    const x = await setup();
    const id = await activity(x, 5 * DAY);
    const res = await api(x.coach.id, "PUT", `/activities/${id}/invitees`, {
      inviteesOnly: true,
      personIds: [x.member.id],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<InviteesJson>()).toMatchObject({ callUpSentAt: null, announced: false });
    const events = (await outbox("activity.invitees.changed", "activityId", id)) as {
      added: string[];
      removed: string[];
    }[];
    expect(events.flatMap((e) => [...e.added, ...e.removed])).toEqual([]);
    expect(await outbox("activity.callup.revoked", "activityIds", id)).toEqual([]);
  });

  it("after it went out, removing someone needs a reason and the person sees it", async () => {
    const x = await setup();
    const id = await activity(x, 2 * DAY);
    await sentAnHourAgo(id);
    const refused = await api(x.coach.id, "PUT", `/activities/${id}/invitees/${x.child.id}`, {
      calledUp: false,
    });
    expect(refused.statusCode).toBe(400);
    expect(detail(refused)).toBe("revocation_reason_required");

    const revoked = await api(x.coach.id, "PUT", `/activities/${id}/invitees/${x.child.id}`, {
      calledUp: false,
      revocationReason: "Vi är för många till matchen",
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<InviteesJson>().revocations).toEqual([
      expect.objectContaining({
        personId: x.child.id,
        reason: "Vi är för många till matchen",
        revokedBy: expect.objectContaining({ id: x.coach.id }) as unknown,
      }),
    ]);
    expect(await outbox("activity.callup.revoked", "activityIds", id)).toEqual([
      expect.objectContaining({ personIds: [x.child.id], seriesId: null }),
    ]);

    // The parent still sees the activity, with the reason, and cannot answer.
    const detailRes = await api(x.parent.id, "GET", `/activities/${id}`);
    expect(detailRes.statusCode, detailRes.body).toBe(200);
    expect(detailRes.json<InviteesJson>().revocations).toEqual([
      expect.objectContaining({ personId: x.child.id, reason: "Vi är för många till matchen" }),
    ]);
    const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(5 * DAY))}`;
    const entry = (await api(x.parent.id, "GET", `/me/schedule?${range}`))
      .json<{
        items: { activityId: string; revocations?: { personId: string; reason: string }[] }[];
      }>()
      .items.find((e) => e.activityId === id);
    expect(entry?.revocations).toEqual([
      expect.objectContaining({ personId: x.child.id, reason: "Vi är för många till matchen" }),
    ]);
    const late = await api(x.parent.id, "PUT", `/activities/${id}/responses/${x.child.id}`, {
      status: "attending",
    });
    expect(late.statusCode).toBe(409);
    // The member (not the child's family) does not see the reason.
    expect(
      (await api(x.member.id, "GET", `/activities/${id}`)).json<InviteesJson>().revocations,
    ).toEqual([]);

    // Called up again: the revocation goes, and adding is told.
    const back = await api(x.coach.id, "PUT", `/activities/${id}/invitees/${x.child.id}`, {
      calledUp: true,
    });
    expect(back.json<InviteesJson>().revocations).toEqual([]);
    const added = (await outbox("activity.invitees.changed", "activityId", id)) as {
      added: string[];
    }[];
    expect(added.at(-1)?.added).toEqual([x.child.id]);
  });

  it("refuses after the start", async () => {
    const x = await setup();
    const id = await activity(x, HOUR);
    await t.query(
      "admin",
      "UPDATE activities SET starts_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );
    const res = await api(x.coach.id, "PUT", `/activities/${id}/invitees/${x.child.id}`, {
      calledUp: false,
      revocationReason: "Sjuk",
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toBe("activity_started");
  });
});

describe("a series' call-up", () => {
  it("applies to its sessions with exceptions, and follows a split", async () => {
    const x = await setup();
    const startsOn = at(7 * DAY).slice(0, 10);
    const created = await api(x.coach.id, "POST", `/groups/${x.team}/activity-series`, {
      title: "Träning",
      slots: [
        { weekday: new Date(startsOn).getUTCDay() || 7, startTime: "18:00", durationMinutes: 60 },
      ],
      startsOn,
      endsOn: at(35 * DAY).slice(0, 10),
    });
    expect(created.statusCode, created.body).toBe(201);
    const seriesId = created.json<{ series: { id: string } }>().series.id;

    const set = await api(x.coach.id, "PUT", `/activity-series/${seriesId}/invitees`, {
      inviteesOnly: true,
      personIds: [x.member.id, x.child.id, x.wilma.id],
    });
    expect(set.statusCode, set.body).toBe(200);
    type Grid = {
      inviteesOnly: boolean;
      people: { person: { id: string }; inSeries: boolean; guest: boolean }[];
      sessions: {
        activityId: string;
        inviteesOnly: boolean;
        cells: { personId: string; calledUp: boolean; override: string | null }[];
      }[];
    };
    const grid = (
      await api(x.coach.id, "GET", `/activity-series/${seriesId}/invitees`)
    ).json<Grid>();
    expect(grid.inviteesOnly).toBe(true);
    expect(grid.sessions.length).toBeGreaterThanOrEqual(4);
    expect(grid.sessions.every((g) => g.inviteesOnly)).toBe(true);
    expect(grid.people.find((p) => p.person.id === x.wilma.id)).toMatchObject({
      inSeries: true,
      guest: true,
    });

    // The child is left out of the second session only (before it went out: silent).
    const second = grid.sessions[1]!.activityId;
    const cell = await api(x.coach.id, "PUT", `/activities/${second}/invitees/${x.child.id}`, {
      calledUp: false,
    });
    expect(cell.statusCode, cell.body).toBe(200);
    // A change of the series' list keeps the exception.
    await api(x.coach.id, "PUT", `/activity-series/${seriesId}/invitees`, {
      inviteesOnly: true,
      personIds: [x.member.id, x.child.id],
    });
    const after = (
      await api(x.coach.id, "GET", `/activity-series/${seriesId}/invitees`)
    ).json<Grid>();
    const cells = (i: number) =>
      Object.fromEntries(after.sessions[i]!.cells.map((c) => [c.personId, c]));
    expect(cells(0)[x.child.id]).toMatchObject({ calledUp: true, override: null });
    expect(cells(1)[x.child.id]).toMatchObject({ calledUp: false, override: "removed" });
    expect(cells(0)[x.wilma.id]?.calledUp ?? false).toBe(false);

    // "This and following" from the third session: the successor has the list.
    const third = after.sessions[2]!.activityId;
    const split = await api(x.coach.id, "POST", `/activity-series/${seriesId}/split`, {
      activityId: third,
      title: "Träning (vår)",
    });
    expect(split.statusCode, split.body).toBe(201);
    const successor = split.json<{ series: { id: string } }>().series.id;
    const next = (
      await api(x.coach.id, "GET", `/activity-series/${successor}/invitees`)
    ).json<Grid>();
    expect(next.inviteesOnly).toBe(true);
    expect(
      next.people
        .filter((p) => p.inSeries)
        .map((p) => p.person.id)
        .sort(),
    ).toEqual([x.member.id, x.child.id].sort());

    // Back to the whole group: the exceptions go.
    const whole = await api(x.coach.id, "PUT", `/activity-series/${seriesId}/invitees`, {
      inviteesOnly: false,
      personIds: [],
    });
    expect(whole.statusCode, whole.body).toBe(200);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM activity_invitee_overrides WHERE activity_id = $1",
      [second],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
