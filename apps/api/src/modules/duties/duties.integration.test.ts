// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6 part A) through the API: the catalogue and the
// country rule (Sweden forbids an adult alone with children; a Norwegian
// club may forbid it itself), shifts of a group and of an activity, sign-up
// counting for the family's player (chosen when there are several), the
// minimum age, a full shift, cancelling one's own but not a leader's
// assignment, quotas per season, and shifts never marked from "Mina uppgifter".

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { DutyQuota, DutyShiftList, DutyTypeList } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltClub,
  type BuiltFamily,
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

async function api(personId: string, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId)}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let norway: BuiltClub;
let teamId: string;
let otherTeamId: string;
let coach: BuiltPerson;
let a: BuiltFamily;
let siblings: BuiltFamily;
let secondChild: string;
let kioskId: string;
let activityId: string;
let shiftId: string;
let seasonId: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  norway = await buildClub(s, { country: "NO" });
  teamId = (await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" })).id;
  otherTeamId = (await s.groups.createGroup(club.ctx, { name: "P2014", kind: "team" })).id;
  coach = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  a = await buildFamily(s, { club, childBirthDate: "2015-03-01" });
  await s.memberships.addToGroup(club.ctx, teamId, a.child.id);
  // A family with two players in the team.
  siblings = await buildFamily(s, { club, childBirthDate: "2015-06-01" });
  await s.memberships.addToGroup(club.ctx, teamId, siblings.child.id);
  const { child } = await s.guardianships.addChild(
    { actorKind: "person", personId: siblings.guardian.id, requestId: "test" },
    { givenName: "Syskon", familyName: siblings.guardian.familyName, birthDate: "2015-09-01" },
  );
  secondChild = child.id;
  await s.memberships.addMember(club.ctx, secondChild);
  await s.memberships.addToGroup(club.ctx, teamId, secondChild);
  seasonId = (
    await s.groups.createSeason(club.ctx, {
      name: "Säsong",
      startsOn: day(-30),
      endsOn: day(300),
    })
  ).id;
  const created = await api(coach.id, "POST", `/groups/${teamId}/activities`, {
    kind: "match",
    title: "Hemmamatch",
    startsAt: `${day(5)}T10:00:00Z`,
    endsAt: `${day(5)}T12:00:00Z`,
  });
  activityId = created.json<{ id: string }>().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("duty types and the country rule", () => {
  it("the club manager keeps the catalogue; Sweden forbids an adult alone with children", async () => {
    const kiosk = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-types`, {
      name: "Kiosk",
      minAge: 13,
    });
    expect(kiosk.statusCode, kiosk.body).toBe(201);
    kioskId = kiosk.json<{ id: string }>().id;
    const same = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-types`, {
      name: "kiosk",
    });
    expect([same.statusCode, detail(same)]).toEqual([409, "duty_type_name_taken"]);
    const alone = await api(club.manager.id, "POST", `/clubs/${club.id}/duty-types`, {
      name: "Nattvandring",
      childContact: "alone_with_children",
    });
    expect([alone.statusCode, detail(alone)]).toEqual([409, "duty_alone_with_children_forbidden"]);
    const changed = await api(club.manager.id, "PATCH", `/clubs/${club.id}/duty-types/${kioskId}`, {
      childContact: "alone_with_children",
    });
    expect(detail(changed)).toBe("duty_alone_with_children_forbidden");
    // The club cannot allow what its country forbids.
    await api(club.manager.id, "PUT", `/clubs/${club.id}/duty-settings`, {
      visibility: "names",
      groupsMayChangeVisibility: false,
      aloneWithChildrenForbidden: false,
    });
    const settings = await api(club.manager.id, "GET", `/clubs/${club.id}/duty-settings`);
    expect(settings.json()).toMatchObject({
      aloneWithChildrenForbidden: true,
      countryForbidsAloneWithChildren: true,
    });
    // Coaches read the catalogue (to plan shifts) but do not keep it.
    const list = await api(coach.id, "GET", `/clubs/${club.id}/duty-types`);
    expect(list.json<DutyTypeList>()).toMatchObject({
      aloneWithChildrenAllowed: false,
      canManage: false,
    });
    expect(list.json<DutyTypeList>().items.map((i) => i.name)).toEqual(["Kiosk"]);
    const denied = await api(coach.id, "POST", `/clubs/${club.id}/duty-types`, { name: "X" });
    expect(denied.statusCode).toBe(403);
    expect(await auditActionsOf(t, club.id)).toContain("duty.type.created");
  });

  it("a Norwegian club allows it until it forbids it itself; then such types get no shifts", async () => {
    const alone = await api(norway.manager.id, "POST", `/clubs/${norway.id}/duty-types`, {
      name: "Nattvakt",
      childContact: "alone_with_children",
    });
    expect(alone.statusCode, alone.body).toBe(201);
    const typeId = alone.json<{ id: string }>().id;
    await api(norway.manager.id, "PUT", `/clubs/${norway.id}/duty-settings`, {
      visibility: "names",
      groupsMayChangeVisibility: false,
      aloneWithChildrenForbidden: true,
    });
    const shift = await api(norway.manager.id, "POST", `/clubs/${norway.id}/duty-shifts`, {
      dutyTypeId: typeId,
      startsAt: `${day(10)}T18:00:00Z`,
      endsAt: `${day(10)}T22:00:00Z`,
    });
    expect([shift.statusCode, detail(shift)]).toEqual([409, "duty_alone_with_children_forbidden"]);
  });
});

describe("shifts, sign-up and assignment", () => {
  it("a coach plans the kiosk at the team's home match; another team's activity is refused", async () => {
    const created = await api(coach.id, "POST", `/clubs/${club.id}/groups/${teamId}/duty-shifts`, {
      dutyTypeId: kioskId,
      startsAt: `${day(5)}T09:30:00Z`,
      endsAt: `${day(5)}T12:30:00Z`,
      needed: 2,
      activityId,
      note: "Ta med växelkassan",
    });
    expect(created.statusCode, created.body).toBe(201);
    shiftId = created.json<{ id: string }>().id;
    const otherActivity = (
      await api(club.manager.id, "POST", `/groups/${otherTeamId}/activities`, {
        kind: "training",
        title: "Träning",
        startsAt: `${day(6)}T10:00:00Z`,
        endsAt: `${day(6)}T11:00:00Z`,
      })
    ).json<{ id: string }>().id;
    const wrong = await api(coach.id, "POST", `/clubs/${club.id}/groups/${teamId}/duty-shifts`, {
      dutyTypeId: kioskId,
      startsAt: `${day(6)}T09:30:00Z`,
      endsAt: `${day(6)}T10:30:00Z`,
      activityId: otherActivity,
    });
    expect(detail(wrong)).toBe("duty_source_invalid");
    const parent = await api(
      a.guardian.id,
      "POST",
      `/clubs/${club.id}/groups/${teamId}/duty-shifts`,
      {
        dutyTypeId: kioskId,
        startsAt: `${day(6)}T09:30:00Z`,
        endsAt: `${day(6)}T10:30:00Z`,
      },
    );
    expect(parent.statusCode).toBe(403);
  });

  it("a parent signs up, counting for their only player; a second sign-up is refused", async () => {
    const signed = await api(
      a.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      {},
    );
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json()).toMatchObject({ countsForPersonId: a.child.id });
    const again = await api(
      a.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      {},
    );
    expect(detail(again)).toBe("duty_already_assigned");
    // The child (10) is below the kiosk's minimum age of 13.
    const child = await api(
      a.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      {
        personId: a.child.id,
      },
    );
    expect(detail(child)).toBe("duty_too_young");
  });

  it("with two players in the team the parent chooses; then the shift is full", async () => {
    const unchosen = await api(
      siblings.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      {},
    );
    expect(detail(unchosen)).toBe("duty_counts_for_required");
    const stranger = await api(
      siblings.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      { countsForPersonId: a.child.id },
    );
    expect(detail(stranger)).toBe("duty_counts_for_invalid");
    const chosen = await api(
      siblings.guardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      { countsForPersonId: secondChild },
    );
    expect(chosen.statusCode, chosen.body).toBe(201);
    const full = await api(
      siblings.coGuardian.id,
      "POST",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups`,
      { countsForPersonId: siblings.child.id },
    );
    expect(detail(full)).toBe("duty_shift_full");
  });

  it("the coach sees everyone; a parent sees their own on the activity's shifts", async () => {
    const list = await api(
      coach.id,
      "GET",
      `/clubs/${club.id}/groups/${teamId}/duty-shifts?from=${day(0)}&to=${day(30)}`,
    );
    const shift = list.json<DutyShiftList>().items[0]!;
    expect(shift).toMatchObject({ filled: 2, needed: 2, note: "Ta med växelkassan" });
    expect(shift.assignments.every((x) => x.person !== null)).toBe(true);
    const parent = await api(a.guardian.id, "GET", `/activities/${activityId}/duty-shifts`);
    expect(parent.statusCode, parent.body).toBe(200);
    const seen = parent.json<DutyShiftList>();
    expect(seen.canSignUp).toBe(true);
    expect(seen.items[0]!.filled).toBe(2);
    expect(seen.items[0]!.assignments).toHaveLength(1);
    expect(seen.items[0]!.assignments[0]).toMatchObject({ mine: true });
  });

  it("a sign-up is cancelled by the family, a leader's assignment only by the leaders", async () => {
    const list = (
      await api(
        coach.id,
        "GET",
        `/clubs/${club.id}/groups/${teamId}/duty-shifts?from=${day(0)}&to=${day(30)}`,
      )
    ).json<DutyShiftList>();
    const siblingsSignup = list.items[0]!.assignments.find((x) => x.countsFor?.id === secondChild)!;
    const cancelled = await api(
      siblings.guardian.id,
      "DELETE",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups/${siblingsSignup.id}`,
    );
    expect(cancelled.statusCode, cancelled.body).toBe(204);
    const assigned = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/groups/${teamId}/duty-shifts/${shiftId}/assignments`,
      { personId: siblings.coGuardian.id, countsForPersonId: siblings.child.id },
    );
    expect(assigned.statusCode, assigned.body).toBe(201);
    const id = assigned.json<{ id: string }>().id;
    const refused = await api(
      siblings.coGuardian.id,
      "DELETE",
      `/clubs/${club.id}/duty-shifts/${shiftId}/signups/${id}`,
    );
    expect(detail(refused)).toBe("duty_assigned_by_leader");
    // Fewer needed than are on the shift is refused.
    const fewer = await api(
      coach.id,
      "PATCH",
      `/clubs/${club.id}/groups/${teamId}/duty-shifts/${shiftId}`,
      { needed: 1 },
    );
    expect(detail(fewer)).toBe("duty_needed_below_filled");
    // The group's shifts are audited on the group.
    expect(await auditActionsOf(t, teamId)).toEqual(
      expect.arrayContaining([
        "duty.shift.created",
        "duty.assignment.registered",
        "duty.assignment.cancelled",
        "duty.assignment.assigned",
      ]),
    );
  });

  it("a shift is not marked done from Mina uppgifter (the leaders mark shifts)", async () => {
    const list = (
      await api(
        coach.id,
        "GET",
        `/clubs/${club.id}/groups/${teamId}/duty-shifts?from=${day(0)}&to=${day(30)}`,
      )
    ).json<DutyShiftList>();
    const mine = list.items[0]!.assignments.find((x) => x.person?.id === a.guardian.id)!;
    const marked = await api(a.guardian.id, "POST", `/me/task-assignments/${mine.id}/status`, {
      status: "done",
    });
    expect(marked.statusCode).toBe(404);
  });
});

describe("quotas", () => {
  it("two shifts per player this season; every player with done and planned", async () => {
    const put = await api(coach.id, "PUT", `/clubs/${club.id}/groups/${teamId}/duty-quotas`, {
      seasonId,
      shiftsPerPlayer: 2,
    });
    expect(put.statusCode, put.body).toBe(204);
    const quota = await api(
      coach.id,
      "GET",
      `/clubs/${club.id}/groups/${teamId}/duty-quotas?seasonId=${seasonId}`,
    );
    const body = quota.json<DutyQuota>();
    expect(body.shiftsPerPlayer).toBe(2);
    const of = (id: string) => body.players.find((p) => p.person?.id === id);
    expect(of(a.child.id)).toMatchObject({ done: 0, planned: 1 });
    expect(of(siblings.child.id)).toMatchObject({ done: 0, planned: 1 });
    expect(of(secondChild)).toMatchObject({ done: 0, planned: 0 });
    const parent = await api(
      a.guardian.id,
      "GET",
      `/clubs/${club.id}/groups/${teamId}/duty-quotas?seasonId=${seasonId}`,
    );
    expect(parent.statusCode).toBe(403);
  });
});
