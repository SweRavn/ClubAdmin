// SPDX-License-Identifier: AGPL-3.0-only
// Car pooling (P2.5 part A) through the API: transport modes on activities
// and series, offers with return trips, bookings for oneself and one's
// child, the self-booking age, the rule of two (a guardian's confirmation,
// asked again when the situation comes back; a leader driving alike),
// who sees whom, "Mina samåkningar", statistics and their public setting,
// the club's settings, deleting old car pools and erasure.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { Carpool, CarpoolStats, MyCarpoolList } from "@clubadmin/shared";
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
let teamId: string;
let coach: BuiltPerson;
let player: BuiltPerson;
let outsider: BuiltPerson;
let a: BuiltFamily;
let b: BuiltFamily;
let teen: BuiltFamily;
let locationId: string;
let activityId: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const carpool = async (personId: string) => {
  const res = await api(personId, "GET", `/activities/${activityId}/carpool`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Carpool>();
};
const bookingOf = (view: Carpool, bookingId: string) =>
  view.offers.flatMap((o) => o.bookings).find((x) => x.id === bookingId);

async function notices(kind: string): Promise<string[][]> {
  const { rows } = await t.query<{ person_ids: string[] }>(
    "admin",
    `SELECT ARRAY(SELECT jsonb_array_elements_text(payload->'personIds')) AS person_ids
     FROM outbox.events WHERE type = 'carpool.changed' AND payload->>'activityId' = $1
       AND payload->>'kind' = $2 ORDER BY created_at, id`,
    [activityId, kind],
  );
  return rows.map((r) => r.person_ids);
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
  club = await buildClub(s);
  teamId = (await s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" })).id;
  coach = await buildPerson(s);
  player = await buildPerson(s, { birthDate: "1990-01-01" });
  outsider = await buildPerson(s);
  for (const p of [coach, player]) await s.memberships.addMember(club.ctx, p.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, teamId, player.id);
  a = await buildFamily(s, { club, childBirthDate: "2014-03-01" });
  b = await buildFamily(s, { club, childBirthDate: "2014-05-01" });
  teen = await buildFamily(s, { club, childBirthDate: "2011-02-01" });
  for (const f of [a, b, teen]) await s.memberships.addToGroup(club.ctx, teamId, f.child.id);
  const place = await api(coach.id, "POST", `/clubs/${club.id}/locations`, {
    name: "Bortaplan",
    distanceKm: 42.5,
  });
  expect(place.statusCode, place.body).toBe(201);
  locationId = place.json<{ id: string }>().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("transport modes (P2.5)", () => {
  it("an activity and a series' sessions carry it; own transport opens the car pool", async () => {
    const res = await api(coach.id, "POST", `/groups/${teamId}/activities`, {
      kind: "match",
      title: "Bortamatch",
      startsAt: `${day(3)}T10:00:00Z`,
      endsAt: `${day(3)}T12:00:00Z`,
      locationId,
      transportMode: "own",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ transportMode: string }>().transportMode).toBe("own");
    activityId = res.json<{ id: string }>().id;

    const series = await api(coach.id, "POST", `/groups/${teamId}/activity-series`, {
      title: "Cupresor",
      slots: [{ weekday: 6, startTime: "09:00", durationMinutes: 120 }],
      startsOn: day(1),
      endsOn: day(14),
      transportMode: "shared",
    });
    expect(series.statusCode, series.body).toBe(201);
    const seriesId = series.json<{ series: { id: string; transportMode: string } }>().series;
    expect(seriesId.transportMode).toBe("shared");
    const { rows } = await t.query<{ transport_mode: string }>(
      "admin",
      "SELECT DISTINCT transport_mode FROM public.activities WHERE series_id = $1",
      [seriesId.id],
    );
    expect(rows.map((r) => r.transport_mode)).toEqual(["shared"]);
  });

  it("without a transport mode the first offer starts the car pool; shared transport has none (P2.7b)", async () => {
    const training = await api(coach.id, "POST", `/groups/${teamId}/activities`, {
      kind: "training",
      title: "Träning",
      startsAt: `${day(4)}T16:00:00Z`,
      endsAt: `${day(4)}T17:30:00Z`,
    });
    expect(training.statusCode, training.body).toBe(201);
    const trainingId = training.json<{ id: string; transportMode: string | null }>().id;
    const view = (await api(a.guardian.id, "GET", `/activities/${trainingId}/carpool`)).json<{
      transportMode: string | null;
      canOffer: boolean;
    }>();
    expect(view).toMatchObject({ transportMode: null, canOffer: true });
    const offer = await api(a.guardian.id, "POST", `/activities/${trainingId}/carpool/offers`, {
      seats: 3,
    });
    expect(offer.statusCode, offer.body).toBe(201);
    // Withdrawn again: the later tests count this team's cars.
    const offerId = offer.json<{ id: string }>().id;
    const removed = await api(
      a.guardian.id,
      "DELETE",
      `/activities/${trainingId}/carpool/offers/${offerId}`,
    );
    expect(removed.statusCode, removed.body).toBeLessThan(300);

    const bus = await api(coach.id, "POST", `/groups/${teamId}/activities`, {
      kind: "match",
      title: "Bussresa",
      startsAt: `${day(5)}T10:00:00Z`,
      endsAt: `${day(5)}T12:00:00Z`,
      transportMode: "shared",
    });
    const busId = bus.json<{ id: string }>().id;
    const refused = await api(a.guardian.id, "POST", `/activities/${busId}/carpool/offers`, {
      seats: 3,
    });
    expect([refused.statusCode, detail(refused)]).toEqual([409, "carpool_closed"]);
  });
});

describe("car pools (P2.5)", () => {
  let outId: string;
  let backId: string;
  let bChildOut: string;
  let aChildOut: string;

  it("shows the car pool to those who see the activity; hidden from outsiders", async () => {
    const view = await carpool(a.guardian.id);
    expect(view).toMatchObject({ transportMode: "own", distanceKm: 42.5, offers: [] });
    expect(view.canOffer).toBe(true);
    expect(view.canBookFor.map((p) => p.id)).toContain(a.child.id);
    expect(view.withoutRide).toBeNull();
    expect((await api(outsider.id, "GET", `/activities/${activityId}/carpool`)).statusCode).toBe(
      404,
    );
  });

  it("adults taking part or guardians of a participant offer cars; children do not", async () => {
    const child = await api(teen.child.id, "POST", `/activities/${activityId}/carpool/offers`, {
      seats: 2,
    });
    expect([child.statusCode, detail(child)]).toEqual([403, "carpool_driver_not_eligible"]);

    const res = await api(a.guardian.id, "POST", `/activities/${activityId}/carpool/offers`, {
      seats: 3,
      departurePlace: "Klubbstugan",
      note: "Plats för bollbag",
      departureAt: `${day(3)}T08:30:00Z`,
      withReturn: true,
      returnDeparturePlace: "Hallens entré",
      returnDepartureAt: `${day(3)}T12:15:00Z`,
    });
    expect(res.statusCode, res.body).toBe(201);
    ({ id: outId, returnId: backId } = res.json<{ id: string; returnId: string }>());
    expect(backId).toBeTruthy();
    const again = await api(a.guardian.id, "POST", `/activities/${activityId}/carpool/offers`, {
      seats: 2,
    });
    expect([again.statusCode, detail(again)]).toEqual([409, "carpool_offer_exists"]);
    const view = await carpool(a.guardian.id);
    expect(view.offers.map((o) => [o.direction, o.seats, o.freeSeats, o.mine])).toEqual([
      ["out", 3, 3, true],
      ["back", 3, 3, true],
    ]);
    expect(view.offers[1]!.outwardOfferId).toBe(outId);
    expect(view.offers[0]!.distanceKm).toBe(42.5);
    // The note goes with the car, the return trip's copy too.
    expect(view.offers.map((o) => o.note)).toEqual(["Plats för bollbag", "Plats för bollbag"]);
    expect((await carpool(player.id)).offers[0]!.note).toBe("Plats för bollbag");
    // The way home has its own place and time, never the outward trip's (P2.7c).
    expect(view.offers.map((o) => [o.departurePlace, o.departureAt])).toEqual([
      ["Klubbstugan", `${day(3)}T08:30:00.000Z`],
      ["Hallens entré", `${day(3)}T12:15:00.000Z`],
    ]);
  });

  it("one adult and a single child not their own: the seat waits for a guardian", async () => {
    const res = await api(
      b.guardian.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: b.child.id, alsoReturn: true },
    );
    expect(res.statusCode, res.body).toBe(201);
    const booked = res.json<{ id: string; status: string; returnId: string | null }>();
    expect(booked.status).toBe("pending_guardian");
    expect(booked.returnId).toBeTruthy();
    bChildOut = booked.id;
    // The driver is told of the booking; the other guardian is asked (not the one who booked).
    expect((await notices("booked")).flat()).toContain(a.guardian.id);
    expect((await notices("confirm")).flat()).toEqual(expect.arrayContaining([b.coGuardian.id]));
    expect((await notices("confirm")).flat()).not.toContain(b.guardian.id);

    const asGuardian = await carpool(b.guardian.id);
    const seat = bookingOf(asGuardian, bChildOut)!;
    expect(seat).toMatchObject({ status: "pending_guardian", canConfirm: true, canCancel: true });
    expect(seat.passenger?.id).toBe(b.child.id);
    expect(asGuardian.offers[0]!.driver?.id).toBe(a.guardian.id);
  });

  it("the schedule's summaries: cars, whom I book for, my family's seats (P2.7c)", async () => {
    type Summaries = {
      items: {
        activityId: string;
        open: boolean;
        offers: {
          id: string;
          direction: string;
          driver: { id: string } | null;
          freeSeats: number;
        }[];
        canBookFor: { id: string }[];
        bookings: { offerId: string; passengerPersonId: string; status: string }[];
      }[];
    };
    const summaries = async (personId: string) => {
      const res = await api(
        personId,
        "GET",
        `/clubs/${club.id}/carpool-summaries?activityIds=${activityId}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Summaries>().items;
    };
    const [mine] = await summaries(b.guardian.id);
    expect(mine).toMatchObject({ activityId, open: true });
    expect(mine!.canBookFor.map((p) => p.id)).toEqual([b.child.id]);
    expect(mine!.offers.map((o) => [o.direction, o.driver?.id])).toEqual([
      ["out", a.guardian.id],
      ["back", a.guardian.id],
    ]);
    // The seats booked above, out and home, waiting for the other guardian.
    expect(mine!.bookings.map((x) => [x.passengerPersonId, x.status])).toEqual([
      [b.child.id, "pending_guardian"],
      [b.child.id, "pending_guardian"],
    ]);
    // Not taking part: nothing (a car names its driver); another club: 404.
    expect(await summaries(outsider.id).catch(() => [])).toEqual([]);
  });

  it("names passengers only to the car's people, families and leaders", async () => {
    const asPlayer = await carpool(player.id);
    expect(asPlayer.offers[0]!.bookings.map((x) => x.passenger)).toEqual([null]);
    expect(asPlayer.offers[0]!.freeSeats).toBe(2);
    const asDriver = await carpool(a.guardian.id);
    expect(asDriver.offers[0]!.bookings[0]!.passenger?.id).toBe(b.child.id);
    const asCoach = await carpool(coach.id);
    expect(asCoach.offers[0]!.bookings[0]!.passenger?.id).toBe(b.child.id);
    // Leaders see who has no seat out yet.
    expect(asCoach.withoutRide?.map((p) => p.id).sort()).toEqual(
      [a.child.id, teen.child.id, player.id].sort(),
    );
  });

  it("only the child's guardian confirms; then the seat is held", async () => {
    const other = await api(a.guardian.id, "POST", `/me/carpool-bookings/${bChildOut}/confirm`);
    expect(other.statusCode).toBe(404);
    const res = await api(b.coGuardian.id, "POST", `/me/carpool-bookings/${bChildOut}/confirm`);
    expect(res.statusCode, res.body).toBe(204);
    expect(bookingOf(await carpool(b.guardian.id), bChildOut)?.status).toBe("held");
    const twice = await api(b.coGuardian.id, "POST", `/me/carpool-bookings/${bChildOut}/confirm`);
    expect([twice.statusCode, detail(twice)]).toEqual([409, "carpool_not_pending"]);
    expect(await auditActionsOf(t, activityId)).toEqual(
      expect.arrayContaining([
        "carpool.offer.created",
        "carpool.booking.created",
        "carpool.booking.confirmed",
      ]),
    );
  });

  it("the driver's own child in the car ends the situation; its removal asks again", async () => {
    const res = await api(
      a.guardian.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: a.child.id },
    );
    expect(res.statusCode, res.body).toBe(201);
    aChildOut = res.json<{ id: string }>().id;
    expect(res.json<{ status: string }>().status).toBe("held");
    const asked = (await notices("confirm")).length;
    const cancel = await api(
      a.guardian.id,
      "DELETE",
      `/activities/${activityId}/carpool/offers/${outId}/bookings/${aChildOut}`,
    );
    expect(cancel.statusCode, cancel.body).toBe(204);
    // B's child is alone with A's parent again: the earlier confirmation went with the change.
    expect(bookingOf(await carpool(b.guardian.id), bChildOut)?.status).toBe("pending_guardian");
    expect((await notices("confirm")).length).toBe(asked + 1);
    await api(b.guardian.id, "POST", `/me/carpool-bookings/${bChildOut}/confirm`);
  });

  it("a child books themselves from the age their guardians allow (the highest)", async () => {
    const own = await api(
      teen.child.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: teen.child.id },
    );
    expect(own.statusCode, own.body).toBe(201);
    const id = own.json<{ id: string }>().id;
    expect(own.json<{ status: string }>().status).toBe("held");
    const cancel = await api(
      teen.child.id,
      "DELETE",
      `/activities/${activityId}/carpool/offers/${outId}/bookings/${id}`,
    );
    expect(cancel.statusCode).toBe(204);
    // One guardian keeps the default (13), the other chooses 16: 16 applies.
    const set = await api(teen.coGuardian.id, "PUT", `/me/wards/${teen.child.id}/carpool-age`, {
      age: 16,
    });
    expect(set.statusCode, set.body).toBe(204);
    // Each guardian reads their own setting (and the country's default).
    const mine = await api(teen.coGuardian.id, "GET", `/me/wards/${teen.child.id}/carpool-age`);
    expect(mine.json()).toEqual({ age: 16, defaultAge: 13 });
    const other = await api(teen.guardian.id, "GET", `/me/wards/${teen.child.id}/carpool-age`);
    expect(other.json()).toEqual({ age: null, defaultAge: 13 });
    const unrelated = await api(a.guardian.id, "GET", `/me/wards/${teen.child.id}/carpool-age`);
    expect(unrelated.statusCode).toBe(404);
    const notMine = await api(a.guardian.id, "PUT", `/me/wards/${teen.child.id}/carpool-age`, {
      age: 10,
    });
    expect(notMine.statusCode).toBe(404);
    const refused = await api(
      teen.child.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: teen.child.id },
    );
    expect([refused.statusCode, detail(refused)]).toEqual([403, "carpool_self_booking_age"]);
    expect((await carpool(teen.child.id)).canBookFor).toEqual([]);
    // Nobody books for someone else's child.
    const stranger = await api(
      player.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: teen.child.id },
    );
    expect(stranger.statusCode).toBe(403);
  });

  it("a leader driving needs the confirmation alike; a guardian may give it when booking", async () => {
    const offer = await api(coach.id, "POST", `/activities/${activityId}/carpool/offers`, {
      seats: 2,
    });
    expect(offer.statusCode, offer.body).toBe(201);
    const coachCar = offer.json<{ id: string }>().id;
    const booked = await api(
      teen.guardian.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${coachCar}/bookings`,
      { passengerPersonId: teen.child.id, confirmAlone: true },
    );
    expect(booked.statusCode, booked.body).toBe(201);
    expect(booked.json<{ status: string }>().status).toBe("held");
    const view = await carpool(coach.id);
    const car = view.offers.find((o) => o.id === coachCar)!;
    expect(car.bookings[0]).toMatchObject({ status: "held" });
    // The same seat booked twice the same way is refused.
    const twice = await api(
      teen.guardian.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      { passengerPersonId: teen.child.id },
    );
    expect([twice.statusCode, detail(twice)]).toEqual([409, "carpool_already_booked"]);
  });

  it("the driver cannot drop seats below those booked, nor book their own car", async () => {
    const res = await api(
      a.guardian.id,
      "POST",
      `/activities/${activityId}/carpool/offers/${outId}/bookings`,
      {
        passengerPersonId: a.guardian.id,
      },
    );
    expect([res.statusCode, detail(res)]).toEqual([400, "carpool_own_car"]);
    const fewer = await api(
      a.guardian.id,
      "PATCH",
      `/activities/${activityId}/carpool/offers/${outId}`,
      {
        seats: 1,
        willingOnly: true,
      },
    );
    expect([fewer.statusCode, detail(fewer)]).toEqual([409, "carpool_seats_taken"]);
    const other = await api(
      b.guardian.id,
      "PATCH",
      `/activities/${activityId}/carpool/offers/${outId}`,
      {
        seats: 4,
      },
    );
    expect(other.statusCode).toBe(403);
    const moved = await api(
      a.guardian.id,
      "PATCH",
      `/activities/${activityId}/carpool/offers/${outId}`,
      {
        departureAt: `${day(3)}T08:00:00Z`,
      },
    );
    expect(moved.statusCode, moved.body).toBe(204);
    expect((await notices("offer_changed")).flat()).toContain(b.guardian.id);
    // The driver sets the seats free and changes the note; the car's people are told.
    const told = (await notices("offer_changed")).length;
    const more = await api(
      a.guardian.id,
      "PATCH",
      `/activities/${activityId}/carpool/offers/${outId}`,
      { seats: 4, note: "Hunden har åkt i bilen" },
    );
    expect(more.statusCode, more.body).toBe(204);
    const car = (await carpool(a.guardian.id)).offers.find((o) => o.id === outId)!;
    expect([car.seats, car.freeSeats, car.note]).toEqual([4, 3, "Hunden har åkt i bilen"]);
    expect((await notices("offer_changed")).length).toBe(told + 1);
    const tooLong = await api(
      a.guardian.id,
      "PATCH",
      `/activities/${activityId}/carpool/offers/${outId}`,
      { note: "x".repeat(301) },
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it("Mina samåkningar: the driver's cars and a guardian's child's seats", async () => {
    const asDriver = await api(a.guardian.id, "GET", "/me/carpools");
    expect(asDriver.statusCode, asDriver.body).toBe(200);
    const drives = asDriver.json<MyCarpoolList>().items.filter((i) => i.driving);
    expect(drives.map((d) => d.direction).sort()).toEqual(["back", "out"]);
    const asGuardian = (await api(b.guardian.id, "GET", "/me/carpools")).json<MyCarpoolList>();
    expect(asGuardian.items.map((i) => [i.direction, i.passenger?.id, i.driver?.id])).toEqual(
      expect.arrayContaining([
        ["out", b.child.id, a.guardian.id],
        ["back", b.child.id, a.guardian.id],
      ]),
    );
  });

  it("statistics: leaders see all; members their own unless the group makes them public", async () => {
    const range = `from=${day(0)}&to=${day(10)}`;
    const url = `/clubs/${club.id}/groups/${teamId}/carpool-stats?${range}`;
    const asCoach = (await api(coach.id, "GET", url)).json<CarpoolStats>();
    const driver = asCoach.rows.find((r) => r.person?.id === a.guardian.id)!;
    expect(driver).toMatchObject({ drives: 2, distanceKm: 85, passengers: 2 });
    expect(asCoach.public).toBe(false);
    const asPlayer = (await api(player.id, "GET", url)).json<CarpoolStats>();
    expect(asPlayer.rows).toEqual([]);
    const asParent = (await api(a.guardian.id, "GET", url)).json<CarpoolStats>();
    expect(asParent.rows.map((r) => r.person?.id)).toEqual([a.guardian.id]);
    const notLeader = await api(
      player.id,
      "PUT",
      `/clubs/${club.id}/groups/${teamId}/carpool-settings`,
      { statsPublic: true },
    );
    expect(notLeader.statusCode).toBe(403);
    const set = await api(coach.id, "PUT", `/clubs/${club.id}/groups/${teamId}/carpool-settings`, {
      statsPublic: true,
    });
    expect(set.statusCode, set.body).toBe(200);
    const shown = (await api(player.id, "GET", url)).json<CarpoolStats>();
    expect(shown.public).toBe(true);
    expect(shown.rows.length).toBeGreaterThan(1);
  });

  it("the driver removes a car before the trip; its passengers' bookers are told", async () => {
    const res = await api(
      a.guardian.id,
      "DELETE",
      `/activities/${activityId}/carpool/offers/${backId}`,
    );
    expect(res.statusCode, res.body).toBe(204);
    expect((await notices("offer_removed")).flat()).toContain(b.guardian.id);
    expect((await carpool(a.guardian.id)).offers.map((o) => o.id)).not.toContain(backId);
  });

  it("the club's starting place and deleting old car pools (club.carpools.manage)", async () => {
    const put = await api(club.manager.id, "PUT", `/clubs/${club.id}/carpool-settings`, {
      startLocationId: locationId,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(
      (await api(club.manager.id, "GET", `/clubs/${club.id}/carpool-settings`)).json(),
    ).toEqual({ startLocationId: locationId });
    const future = await api(
      club.manager.id,
      "DELETE",
      `/clubs/${club.id}/carpools?before=${day(30)}`,
    );
    expect([future.statusCode, detail(future)]).toEqual([400, "carpool_before_invalid"]);
    const old = await api(club.manager.id, "DELETE", `/clubs/${club.id}/carpools?before=${day(0)}`);
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json()).toEqual({ offers: 0 });
  });

  it("erasure clears the meeting place of the person's drives, in history too", async () => {
    await t.query("admin", "SELECT privacy.erase_person($1, 'test')", [a.guardian.id]);
    const { rows } = await t.query<{ departure_place: string | null; note: string | null }>(
      "admin",
      "SELECT departure_place, note FROM public.carpool_offers WHERE id = $1",
      [outId],
    );
    expect(rows[0]).toEqual({ departure_place: null, note: null });
    const { rows: history } = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM history.record_changes
       WHERE table_name = 'public.carpool_offers' AND record_id = $1
         AND 'Klubbstugan' IN (old_values->>'departure_place', new_values->>'departure_place')`,
      [outId],
    );
    expect(history[0]?.n).toBe(0);
  });
});
