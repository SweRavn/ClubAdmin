// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up through the HTTP API (P1.6, ADR 0038): a coach's
// group event with a form (a sensitive question), drafts, a guardian
// signing up a child, who sees sealed answers, the waiting list with
// offers (accept, decline, expiry), automatic moving up, deadlines, the
// call-up of the event's activities, a club event, the CSV export,
// "My events", and 100 parallel sign-ups for 20 places.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { createKeyring, generateKeyBase64, parseMasterKeys } from "@clubadmin/server-kit/crypto";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FieldEncryption } from "../../platform/crypto/field-encryption.ts";
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
  // One set of keys for the app and the services (both read sealed answers).
  const keys = { masterKeys: `test:${generateKeyBase64()}`, blindIndexKey: generateKeyBase64() };
  s = createCoreServices(t.db, {
    encryption: new FieldEncryption(
      createKeyring({
        masterKeys: parseMasterKeys(keys.masterKeys),
        blindIndexKey: keys.blindIndexKey,
      }),
    ),
  });
  app = await createTestApp({
    ENCRYPTION_MASTER_KEYS: keys.masterKeys,
    BLIND_INDEX_KEY: keys.blindIndexKey,
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
      },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface Reg {
  person: { id: string };
  status: string;
  position: number | null;
  offerExpiresAt: string | null;
  answers: Record<string, unknown>;
  sensitiveAnswers?: Record<string, unknown>;
  registeredBy: { id: string } | null;
}
interface Detail {
  id: string;
  status: string;
  open: boolean;
  canManage: boolean;
  counts: { confirmed: number; offered: number; waiting: number; placesLeft: number | null };
  activities: { id: string }[];
  mine: { person: { id: string }; registration: Reg | null; canRegister: boolean }[];
  participants: { id: string }[] | null;
}

interface Team {
  club: BuiltClub;
  groupId: string;
  coach: BuiltPerson;
  members: BuiltPerson[];
  parent: BuiltPerson;
  child: { id: string };
  grandmother: BuiltPerson;
}

/** A team: a coach, `n` adult members, and a child with a parent and a relative (view_schedule). */
async function team(n = 3): Promise<Team> {
  const club = await buildClub(s);
  const group = await s.groups.createGroup(club.ctx, { name: "P2015", kind: "team" });
  const join = async (fn: "member" | "head_coach") => {
    const person = await buildPerson(s);
    await s.memberships.addMember(club.ctx, person.id);
    await s.memberships.addToGroup(club.ctx, group.id, person.id, fn);
    return person;
  };
  const coach = await join("head_coach");
  const members: BuiltPerson[] = [];
  for (let i = 0; i < n; i++) members.push(await join("member"));
  const parent = await buildPerson(s);
  const { child } = await s.guardianships.addChild(actor(parent.id), {
    givenName: "Ebbe",
    familyName: parent.familyName,
    birthDate: "2015-04-01",
  });
  await s.memberships.addMember(club.ctx, child.id);
  await s.memberships.addToGroup(club.ctx, group.id, child.id);
  const grandmother = await buildPerson(s);
  await s.guardianships.addGuardian(actor(parent.id), {
    guardianPersonId: grandmother.id,
    wardPersonId: child.id,
    kind: "relative",
  });
  return { club, groupId: group.id, coach, members, parent, child, grandmother };
}

const QUESTIONS = [
  { id: "size", type: "choice", label: "T-shirt size", required: true, options: ["S", "M", "L"] },
  { id: "allergy", type: "long_text", label: "Allergies", sensitive: true },
  { id: "car", type: "yes_no", label: "Can drive" },
];

async function createEvent(x: Team, body: Record<string, unknown> = {}): Promise<string> {
  const res = await api(x.coach.id, "POST", `/clubs/${x.club.id}/events`, {
    body: {
      title: "Höstcupen",
      audience: "groups",
      groupIds: [x.groupId],
      startsAt: at(10 * DAY),
      endsAt: at(10 * DAY + 8 * HOUR),
      registrationClosesAt: at(7 * DAY),
      publish: true,
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const register = (personId: string, eventId: string, who: string, answers: object = {}) =>
  api(personId, "PUT", `/events/${eventId}/registrations/${who}`, { body: { answers } });

async function invitees(activityId: string): Promise<string[]> {
  const { rows } = await t.query<{ person_id: string }>(
    "admin",
    "SELECT person_id FROM activity_invitees WHERE activity_id = $1 ORDER BY person_id",
    [activityId],
  );
  return rows.map((r) => r.person_id);
}

describe("a group event", () => {
  it("drafts are for organisers; a guardian signs up a child; sealed answers stay with organisers and guardians", async () => {
    const x = await team();
    const eventId = await createEvent(x, {
      publish: false,
      questions: QUESTIONS,
      activities: [
        {
          kind: "match",
          title: "Cup day 1",
          startsAt: at(10 * DAY),
          endsAt: at(10 * DAY + 4 * HOUR),
        },
      ],
    });
    expect((await api(x.members[0]!.id, "GET", `/events/${eventId}`)).statusCode).toBe(404);
    expect((await api(x.coach.id, "GET", `/events/${eventId}`)).statusCode).toBe(200);
    expect((await api(x.coach.id, "POST", `/events/${eventId}/publish`)).statusCode).toBe(200);

    // The child's activity is called up to nobody yet.
    const event = (await api(x.parent.id, "GET", `/events/${eventId}`)).json<Detail>();
    const activityId = event.activities[0]!.id;
    expect(await invitees(activityId)).toEqual([]);
    expect(event.mine.find((m) => m.person.id === x.child.id)?.canRegister).toBe(true);

    expect(detail(await register(x.parent.id, eventId, x.child.id, {}))).toBe("answer_required");
    expect(detail(await register(x.parent.id, eventId, x.child.id, { size: "XL" }))).toBe(
      "answer_invalid",
    );
    expect(detail(await register(x.parent.id, eventId, x.child.id, { size: "M", shoe: 38 }))).toBe(
      "answer_invalid",
    );
    // The relative without sign_up sees the event but cannot sign up.
    expect((await api(x.grandmother.id, "GET", `/events/${eventId}`)).statusCode).toBe(200);
    expect((await register(x.grandmother.id, eventId, x.child.id, { size: "M" })).statusCode).toBe(
      403,
    );

    const res = await register(x.parent.id, eventId, x.child.id, {
      size: "M",
      allergy: "Nuts",
      car: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    const mine = res.json<Detail>().mine.find((m) => m.person.id === x.child.id)!;
    expect(mine.registration).toMatchObject({
      status: "confirmed",
      answers: { size: "M", car: false },
      sensitiveAnswers: { allergy: "Nuts" },
      registeredBy: { id: x.parent.id },
    });
    expect(await invitees(activityId)).toEqual([x.child.id]);

    // Sealed in the database: never in clear text, not in history either.
    const { rows } = await t.query<{ answers: object; sensitive_answers: string }>(
      "admin",
      "SELECT answers, sensitive_answers FROM event_registrations WHERE event_id = $1",
      [eventId],
    );
    expect(rows[0]!.sensitive_answers).not.toContain("Nuts");
    expect(JSON.stringify(rows[0]!.answers)).not.toContain("Nuts");

    // Organisers see the sealed answers; a teammate sees counts and names but no answers.
    const list = await api(x.coach.id, "GET", `/events/${eventId}/registrations`);
    expect(list.json<{ items: Reg[] }>().items[0]).toMatchObject({
      sensitiveAnswers: { allergy: "Nuts" },
    });
    const teammate = (await api(x.members[0]!.id, "GET", `/events/${eventId}`)).json<Detail>();
    expect(teammate.counts).toMatchObject({ confirmed: 1, placesLeft: null });
    expect(teammate.participants?.map((p) => p.id)).toEqual([x.child.id]);
    expect(JSON.stringify(teammate)).not.toContain("Nuts");
    expect(
      (await api(x.members[0]!.id, "GET", `/events/${eventId}/registrations`)).statusCode,
    ).toBe(403);

    // Changing answers is audited with question IDs, never values.
    await register(x.parent.id, eventId, x.child.id, { size: "L", allergy: "Nuts" });
    const { rows: audits } = await t.query<{ action: string; changed_fields: string[] }>(
      "admin",
      "SELECT action, changed_fields FROM audit.events WHERE club_id = $1 AND action LIKE 'event.%' ORDER BY created_at, id",
      [x.club.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      "event.created",
      "event.published",
      "event.registration.created",
      "event.registration.updated",
    ]);
    expect(audits.at(-1)!.changed_fields).toEqual(["size", "car"]);

    // The CSV: without sensitive answers by default; with them only with MFA.
    const csv = await api(x.coach.id, "GET", `/events/${eventId}/registrations.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("T-shirt size");
    expect(csv.body).not.toContain("Nuts");
    expect(
      (await api(x.coach.id, "GET", `/events/${eventId}/registrations.csv?sensitive=true`))
        .statusCode,
    ).toBe(403);
    const sealed = await api(
      x.coach.id,
      "GET",
      `/events/${eventId}/registrations.csv?sensitive=true`,
      {
        mfa: true,
      },
    );
    expect(sealed.body).toContain("Nuts");

    // Drafts only can be deleted; cancelling cancels the activities and keeps registrations.
    expect(detail(await api(x.coach.id, "DELETE", `/events/${eventId}`))).toBe("event_not_draft");
    const cancelled = await api(x.coach.id, "POST", `/events/${eventId}/cancel`, {
      body: { reason: "Too few teams" },
    });
    expect(cancelled.json<{ status: string }>().status).toBe("cancelled");
    const activity = await api(x.coach.id, "GET", `/activities/${activityId}`);
    expect(activity.json<{ status: string }>().status).toBe("cancelled");
    expect(detail(await register(x.members[0]!.id, eventId, x.members[0]!.id, { size: "S" }))).toBe(
      "event_cancelled",
    );
  });

  it("offers a freed place to the next in the queue: accept, decline, expiry", async () => {
    const x = await team(4);
    const [a, b, c, d] = x.members as [BuiltPerson, BuiltPerson, BuiltPerson, BuiltPerson];
    const eventId = await createEvent(x, {
      capacity: 1,
      waitlistMode: "offer",
      offerReplyHours: 24,
    });
    expect((await register(a.id, eventId, a.id)).statusCode).toBe(200);
    for (const p of [b, c, d]) await register(p.id, eventId, p.id);
    const waiting = (await api(c.id, "GET", `/events/${eventId}`)).json<Detail>();
    expect(waiting.mine[0]!.registration).toMatchObject({ status: "waitlisted", position: 2 });
    expect(waiting.counts).toEqual({ confirmed: 1, offered: 0, waiting: 3, placesLeft: 0 });

    // A cancels: B is offered the place.
    await api(a.id, "DELETE", `/events/${eventId}/registrations/${a.id}`);
    const offered = (await api(b.id, "GET", `/events/${eventId}`)).json<Detail>();
    expect(offered.mine[0]!.registration?.status).toBe("offered");
    expect(offered.counts.placesLeft).toBe(0);
    // A new sign-up goes behind the queue, not into the offered place.
    expect(detail(await api(c.id, "POST", `/events/${eventId}/registrations/${c.id}/accept`))).toBe(
      "no_offer",
    );

    // B declines: C is offered; the offer expires: D is offered; D accepts.
    await api(b.id, "POST", `/events/${eventId}/registrations/${b.id}/decline`);
    expect(
      (await api(c.id, "GET", `/events/${eventId}`)).json<Detail>().mine[0]!.registration?.status,
    ).toBe("offered");
    await t.query(
      "admin",
      "UPDATE event_registrations SET offer_expires_at = now() - interval '1 minute' WHERE event_id = $1 AND status = 'offered'",
      [eventId],
    );
    expect(detail(await api(c.id, "POST", `/events/${eventId}/registrations/${c.id}/accept`))).toBe(
      "offer_expired",
    );
    for (const due of await s.events.dueOffers(100)) await s.events.expireOffer(due.clubId, due.id);
    expect(
      (await api(c.id, "GET", `/events/${eventId}`)).json<Detail>().mine[0]!.registration?.status,
    ).toBe("expired");
    const accepted = await api(d.id, "POST", `/events/${eventId}/registrations/${d.id}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<Detail>().mine[0]!.registration?.status).toBe("confirmed");

    const { rows } = await t.query<{ action: string }>(
      "admin",
      "SELECT action FROM audit.events WHERE club_id = $1 AND action LIKE 'event.registration.%' ORDER BY created_at, id",
      [x.club.id],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "event.registration.offered",
        "event.registration.declined",
        "event.registration.expired",
        "event.registration.accepted",
      ]),
    );
    const { rows: mails } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'event.offer.made' AND payload->>'eventId' = $1",
      [eventId],
    );
    expect(mails[0]!.n).toBe(3);
  });

  it("moves the queue up automatically, by organisers out of order, and when the capacity grows", async () => {
    const x = await team(4);
    const [a, b, c, d] = x.members as [BuiltPerson, BuiltPerson, BuiltPerson, BuiltPerson];
    const eventId = await createEvent(x, {
      capacity: 1,
      waitlistMode: "auto",
      activities: [
        { kind: "match", title: "Final", startsAt: at(10 * DAY), endsAt: at(10 * DAY + HOUR) },
      ],
    });
    for (const p of [a, b, c, d]) await register(p.id, eventId, p.id);
    const activityId = (await api(x.coach.id, "GET", `/events/${eventId}`)).json<Detail>()
      .activities[0]!.id;
    expect(await invitees(activityId)).toEqual([a.id]);

    await api(x.coach.id, "POST", `/events/${eventId}/registrations/${a.id}/remove`, {
      body: { reason: "Injured" },
    });
    expect(await invitees(activityId)).toEqual([b.id]);

    expect(
      detail(
        await api(x.coach.id, "POST", `/events/${eventId}/registrations/${d.id}/confirm`, {
          body: { reason: "Goalkeeper" },
        }),
      ),
    ).toBe("event_full");
    expect(
      detail(await api(x.coach.id, "PATCH", `/events/${eventId}`, { body: { capacity: 0 } })),
    ).toBeUndefined(); // validation: at least 1
    const raised = await api(x.coach.id, "PATCH", `/events/${eventId}`, { body: { capacity: 2 } });
    expect(raised.json<Detail>().counts).toMatchObject({ confirmed: 2, waiting: 1 });
    expect(await invitees(activityId)).toEqual([b.id, c.id].sort());
    expect(
      detail(await api(x.coach.id, "PATCH", `/events/${eventId}`, { body: { capacity: 1 } })),
    ).toBe("capacity_below_confirmed");
  });

  it("closes sign-up and cancellation at their deadlines", async () => {
    const x = await team(2);
    const [a, b] = x.members as [BuiltPerson, BuiltPerson];
    const eventId = await createEvent(x, {
      registrationOpensAt: at(DAY),
      registrationClosesAt: at(2 * DAY),
    });
    expect(detail(await register(a.id, eventId, a.id))).toBe("registration_not_open");
    await api(x.coach.id, "PATCH", `/events/${eventId}`, {
      body: { registrationOpensAt: null, cancellationClosesAt: at(-HOUR) },
    });
    expect((await register(a.id, eventId, a.id)).statusCode).toBe(200);
    expect(detail(await api(a.id, "DELETE", `/events/${eventId}/registrations/${a.id}`))).toBe(
      "cancellation_closed",
    );
    await t.query(
      "admin",
      "UPDATE events SET registration_closes_at = now() - interval '1 minute' WHERE id = $1",
      [eventId],
    );
    expect(detail(await register(b.id, eventId, b.id))).toBe("registration_closed");
    // A member outside the audience groups does not see the event.
    const stranger = await buildPerson(s);
    await s.memberships.addMember(x.club.ctx, stranger.id);
    expect((await register(stranger.id, eventId, stranger.id)).statusCode).toBe(404);
  });
});

describe("a club event", () => {
  it("is created by club managers and the board, open to every member, listed in My events", async () => {
    const x = await team(1);
    const body = {
      title: "Avslutningsfest",
      audience: "club",
      startsAt: at(20 * DAY),
      endsAt: at(20 * DAY + 4 * HOUR),
      registrationClosesAt: at(15 * DAY),
      capacity: 50,
      publish: true,
    };
    expect(detail(await api(x.coach.id, "POST", `/clubs/${x.club.id}/events`, { body }))).toBe(
      "not_allowed",
    );
    const res = await api(x.club.manager.id, "POST", `/clubs/${x.club.id}/events`, { body });
    expect(res.statusCode, res.body).toBe(201);
    const event = res.json<{ id: string; waitlistMode: string }>();
    expect(event.waitlistMode).toBe("auto");

    const member = x.members[0]!;
    const list = await api(member.id, "GET", `/clubs/${x.club.id}/events`);
    expect(list.json<{ items: { id: string }[] }>().items.map((e) => e.id)).toContain(event.id);
    const mine = await api(x.parent.id, "GET", "/me/events");
    const item = mine
      .json<{
        items: {
          event: { id: string };
          people: { person: { id: string }; canRegister: boolean }[];
        }[];
      }>()
      .items.find((i) => i.event.id === event.id);
    expect(item?.people).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ id: x.child.id }) as unknown,
        canRegister: true,
      }),
    ]);
    expect((await register(x.parent.id, event.id, x.child.id)).statusCode).toBe(200);

    // A stranger to the club sees nothing.
    const outsider = await buildPerson(s);
    expect((await api(outsider.id, "GET", `/events/${event.id}`)).statusCode).toBe(404);
    expect(
      (await api(outsider.id, "GET", "/me/events")).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });
});

describe("capacity under concurrency", () => {
  it("gives 20 places to 100 parallel sign-ups, the rest wait in order", async () => {
    const x = await team(0);
    const people: string[] = [];
    for (let i = 0; i < 100; i++) {
      const p = await buildPerson(s);
      await s.memberships.addMember(x.club.ctx, p.id);
      await s.memberships.addToGroup(x.club.ctx, x.groupId, p.id);
      people.push(p.id);
    }
    const eventId = await createEvent(x, { capacity: 20, waitlistMode: "auto" });
    const results = await Promise.allSettled(
      people.map((id) => s.events.register(actor(id, x.club.id), eventId, id, { answers: {} })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const { rows } = await t.query<{ status: string; n: number }>(
      "admin",
      "SELECT status, count(*)::int AS n FROM event_registrations WHERE event_id = $1 GROUP BY status ORDER BY status",
      [eventId],
    );
    expect(rows).toEqual([
      { status: "confirmed", n: 20 },
      { status: "waitlisted", n: 80 },
    ]);
  });
});

describe("only the name and the start are required (P1.6b)", () => {
  it("ends at the end of the start day in the club's time zone; sign-up closes at the start", async () => {
    const x = await team(1);
    const res = await api(x.coach.id, "POST", `/clubs/${x.club.id}/events`, {
      body: {
        title: "Lagfest",
        audience: "groups",
        groupIds: [x.groupId],
        startsAt: "2027-03-10T17:00:00Z",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    // 23:59 in Europe/Stockholm (CET, UTC+1).
    expect(res.json()).toMatchObject({
      endsAt: "2027-03-10T22:59:00.000Z",
      registrationClosesAt: "2027-03-10T17:00:00.000Z",
      status: "draft",
    });
  });

  it("refuses an end before the start, on create and on change", async () => {
    const x = await team(1);
    const bad = await api(x.coach.id, "POST", `/clubs/${x.club.id}/events`, {
      body: {
        title: "Läger",
        audience: "groups",
        groupIds: [x.groupId],
        startsAt: at(10 * DAY),
        endsAt: at(9 * DAY),
      },
    });
    expect([bad.statusCode, detail(bad)]).toEqual([400, "event_period_invalid"]);
    const id = await createEvent(x);
    const changed = await api(x.coach.id, "PATCH", `/events/${id}`, {
      body: { endsAt: at(5 * DAY) },
    });
    expect([changed.statusCode, detail(changed)]).toEqual([400, "event_period_invalid"]);
  });
});
