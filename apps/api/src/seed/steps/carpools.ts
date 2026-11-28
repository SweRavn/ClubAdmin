// SPDX-License-Identifier: AGPL-3.0-only
// Demo car pools and mileage claims (P2.5, ADR 0048, docs/seed-data.md), in
// IK Norrbacka's P2012 (Oskar's team; Ahmed is its head coach and owner):
// - the board decided a mileage rate of 25 kr per mil (250 öre per km);
//   the club's starting place is Norrbacka IP; the away ground is 38 km off;
// - Saturday's away match with own transport: Anna offers three seats with a
//   return trip; Oskar (her son) and Liam (Ahmed's) ride out; Liam's seat home
//   alone with Anna waits for his guardian's confirmation; Ahmed drives four
//   players; one player has no ride yet;
// - two earlier away matches Anna drove to: one claim attested by Ahmed, one
//   rejected with a reason.
// Written through the services as the personas.

import { type ActorContext, sql, type TenantContext } from "@clubadmin/db";

import { CarpoolsService } from "../../modules/carpools/index.ts";
import type { DemoStep } from "../environment.ts";

/** Fixed IDs of the demo car pools. */
export const DEMO_CARPOOL_IDS = {
  awayGround: "0199a000-0000-7000-8013-000000000010",
  awayMatch: "0199a000-0000-7000-8015-000000000010",
  pastMatch1: "0199a000-0000-7000-8015-000000000011",
  pastMatch2: "0199a000-0000-7000-8015-000000000012",
  /** SVK F2017's away match with two families' cars (P2.7c). */
  svkF2017Match: "0199a000-0000-7000-8015-000000000013",
  /** F2017's coming sessions nobody drives to yet: "Skapa samåkning" for Erik and Mikael. */
  svkExtraTraining: "0199a000-0000-7000-8015-000000000014",
  svkFriendlyMatch: "0199a000-0000-7000-8015-000000000015",
  svkBeachTraining: "0199a000-0000-7000-8015-000000000016",
} as const;

const DAY_MS = 86_400_000;

export const carpoolsDemoStep: DemoStep = {
  name: "carpools",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`carpools seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const clubId = id("ikn");
    const teamId = id("ikn-p2012");
    const as = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId,
      requestId: "seed:carpools",
    });
    const asPerson = (personId: string): TenantContext => ({
      actorKind: "person",
      personId,
      clubId,
      requestId: "seed:carpools",
    });
    const actor = (persona: string): ActorContext => ({
      actorKind: "person",
      personId: id(persona),
      requestId: "seed:carpools",
    });
    const now = env.clock.now.getTime();
    const date = (offset: number) => new Date(now + offset * DAY_MS).toISOString().slice(0, 10);

    // The board's rate (a recorded decision) and the club's starting place.
    await s.clubPrivacy.recordDecision(as("goran"), {
      body: "board",
      decidedOn: date(-40),
      reference: "Styrelsemöte 2, § 9",
      settings: { mileage_rate: 250 },
    });
    await s.carpools.setSettings(as("goran"), {
      startLocationId: "0199a000-0000-7000-8013-000000000003",
    });
    // Erik and Mikael keep car-pool defaults (P2.7f): "Skapa samåkning" on the group page.
    await s.carpools.setMySettings(actor("erik"), {
      seats: 3,
      departurePlace: "Hamngatan 4",
      note: "Plats för en bollbag",
      returnMinutes: 20,
    });
    await s.carpools.setMySettings(actor("mikael"), {
      seats: 2,
      departurePlace: "Strandviksskolan",
      note: null,
      returnMinutes: null,
    });
    await s.activities.createLocation(
      as("ahmed"),
      { name: "Kalmarvallen", street: "Vallgatan 1", city: "Kalmarby", distanceKm: 38 },
      { id: DEMO_CARPOOL_IDS.awayGround },
    );
    const ahmed = as("ahmed");
    const match = (title: string, offset: number, matchId: string) =>
      s.activities.createActivity(
        ahmed,
        teamId,
        {
          kind: "match",
          title,
          opponent: "Kalmarby IF",
          homeAway: "away",
          startsAt: `${date(offset)}T10:00:00Z`,
          endsAt: `${date(offset)}T12:00:00Z`,
          meetAt: `${date(offset)}T08:30:00Z`,
          meetPlace: "Norrbacka IP",
          locationId: DEMO_CARPOOL_IDS.awayGround,
          transportMode: "own",
        },
        { id: matchId },
      );

    // Saturday's away match.
    await match("Bortamatch mot Kalmarby IF", 4, DEMO_CARPOOL_IDS.awayMatch);
    const awayId = DEMO_CARPOOL_IDS.awayMatch;
    const anna = await s.carpools.createOffer(as("anna"), awayId, {
      seats: 3,
      departurePlace: "Norrbacka IP",
      departureAt: `${date(4)}T08:30:00Z`,
      note: "Plats för bollbag och lite packning",
      withReturn: true,
      returnDeparturePlace: "Kalmarvallen",
      returnDepartureAt: `${date(4)}T12:15:00Z`,
    });
    await s.carpools.book(as("anna"), awayId, anna.id, { passengerPersonId: id("oskar") });
    await s.carpools.book(ahmed, awayId, anna.id, { passengerPersonId: id("liam") });
    // Home, Liam is the only child with Anna: his seat waits for Ahmed's confirmation.
    await s.carpools.book(ahmed, awayId, anna.returnId!, { passengerPersonId: id("liam") });
    const coachCar = await s.carpools.createOffer(ahmed, awayId, {
      seats: 4,
      departurePlace: "Norrbacka IP",
      departureAt: `${date(4)}T08:30:00Z`,
    });
    // Five of the team's players book themselves (from 13, the pack's age); one has no ride.
    const players = core.generated.get("ikn-p2012") ?? [];
    for (const [i, player] of players.slice(0, 5).entries()) {
      await s.carpools.book(asPerson(player), awayId, i < 4 ? coachCar.id : anna.id, {
        passengerPersonId: player,
      });
    }

    // Two earlier away matches Anna drove to, each there and back (offered before them).
    for (const [offset, matchId] of [
      [-24, DEMO_CARPOOL_IDS.pastMatch1],
      [-10, DEMO_CARPOOL_IDS.pastMatch2],
    ] as const) {
      await match("Bortamatch mot Kalmarby IF", offset, matchId);
      const before = new CarpoolsService(env.db, {
        guardianships: s.guardianships,
        now: () => new Date(now + (offset - 2) * DAY_MS),
      });
      const offer = await before.createOffer(as("anna"), matchId, {
        seats: 3,
        departurePlace: "Norrbacka IP",
        withReturn: true,
      });
      await before.book(as("anna"), matchId, offer.id, {
        passengerPersonId: id("oskar"),
        alsoReturn: true,
      });
    }

    // Anna's claims: the first match attested by Ahmed, the second rejected.
    const drives = await s.expenses.claimable(as("anna"));
    const of = (matchId: string) =>
      drives.drives.filter((d) => d.activityId === matchId).map((d) => d.offerId);
    const scope = { club: false as const, groupIds: [teamId], ownedGroupIds: [] };
    const first = await s.expenses.createMileageClaim(actor("anna"), {
      clubId,
      groupId: teamId,
      offerIds: of(DEMO_CARPOOL_IDS.pastMatch1),
    });
    await s.expenses.decide(ahmed, scope, first.id, { decision: "approve" });
    const second = await s.expenses.createMileageClaim(actor("anna"), {
      clubId,
      groupId: teamId,
      offerIds: of(DEMO_CARPOOL_IDS.pastMatch2),
    });
    await s.expenses.decide(ahmed, scope, second.id, {
      decision: "reject",
      reason: "Laget åkte buss till den matchen. Hör av dig om något är fel.",
    });

    // SVK F2017's away match (P2.7c): Elsa's father Mikael drives there and
    // home, the assistant coach Johan there only; Erik and Sara (Alva's
    // mother) find seats from "Mitt schema" or the "Kommer" menu.
    const svk = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId: id("svk"),
      requestId: "seed:carpools",
    });
    await s.activities.createActivity(
      svk("erik"),
      id("svk-f2017"),
      {
        kind: "match",
        title: "Bortamatch mot Bergby VK",
        opponent: "Bergby VK",
        homeAway: "away",
        startsAt: `${date(5)}T09:00:00Z`,
        endsAt: `${date(5)}T11:00:00Z`,
        locationText: "Bergby sporthall",
        transportMode: "own",
        responseMode: "requested",
      },
      { id: DEMO_CARPOOL_IDS.svkF2017Match },
    );
    await s.carpools.createOffer(svk("mikael"), DEMO_CARPOOL_IDS.svkF2017Match, {
      seats: 3,
      departurePlace: "Strandviksskolan",
      departureAt: `${date(5)}T07:45:00Z`,
      withReturn: true,
      returnDeparturePlace: "Bergby sporthall",
      returnDepartureAt: `${date(5)}T11:15:00Z`,
    });
    await s.carpools.createOffer(svk("johan"), DEMO_CARPOOL_IDS.svkF2017Match, {
      seats: 2,
      departurePlace: "Klubbstugan",
      departureAt: `${date(5)}T07:30:00Z`,
    });

    // Planned rides to F2017's coming trainings (P2.7d): Erik drives to the
    // next one with three seats, Maja and Johan have two, one is free (Alva
    // has said she is coming and can take it); Mikael drives Elsa there and
    // home to the one after.
    const trainings = (
      await s.activities.groupCalendar(svk("anna"), id("svk-f2017"), {
        from: new Date(now + DAY_MS).toISOString(),
        to: new Date(now + 14 * DAY_MS).toISOString(),
        limit: 50,
      })
    ).items
      .map((v) => v.activity)
      .filter((a) => a.kind === "training" && a.status === "scheduled")
      .slice(0, 2);
    const [next, after] = trainings;
    if (next) {
      const at = (minutesBefore: number) =>
        new Date(next.startsAt.getTime() - minutesBefore * 60_000).toISOString();
      const eriks = await s.carpools.createOffer(svk("erik"), next.id, {
        seats: 3,
        departurePlace: "Strandviksskolan",
        departureAt: at(30),
        withReturn: true,
        returnDeparturePlace: "Hallens entré",
        returnDepartureAt: new Date(next.endsAt.getTime() + 10 * 60_000).toISOString(),
      });
      await s.carpools.book(svk("erik"), next.id, eriks.id, {
        passengerPersonId: id("maja"),
        alsoReturn: true,
      });
      await s.carpools.book(svk("johan"), next.id, eriks.id, { passengerPersonId: id("johan") });
    }
    if (after) {
      const mikaels = await s.carpools.createOffer(svk("mikael"), after.id, {
        seats: 2,
        departurePlace: "Ekvägen 3",
        departureAt: new Date(after.startsAt.getTime() - 25 * 60_000).toISOString(),
        withReturn: true,
        returnDeparturePlace: "Hallens entré",
      });
      await s.carpools.book(svk("mikael"), after.id, mikaels.id, {
        passengerPersonId: id("elsa"),
        alsoReturn: true,
      });
    }

    // Coming F2017 sessions where the families take their own cars and nobody
    // drives yet: Erik and Mikael (who keep defaults) get "Skapa samåkning"
    // under them in Mitt schema (web and app) and on the group's page.
    const session = (
      id_: string,
      offset: number,
      values: {
        kind: "training" | "match" | "other";
        title: string;
        startTime: string;
        endTime: string;
        locationText: string;
        kindLabel?: string;
        opponent?: string;
      },
    ) =>
      s.activities.createActivity(
        svk("erik"),
        id("svk-f2017"),
        {
          kind: values.kind,
          title: values.title,
          ...(values.kindLabel ? { kindLabel: values.kindLabel } : {}),
          ...(values.opponent ? { opponent: values.opponent, homeAway: "away" as const } : {}),
          startsAt: `${date(offset)}T${values.startTime}:00Z`,
          endsAt: `${date(offset)}T${values.endTime}:00Z`,
          locationText: values.locationText,
          transportMode: "own",
        },
        { id: id_ },
      );
    await session(DEMO_CARPOOL_IDS.svkExtraTraining, 1, {
      kind: "training",
      title: "Extrapass i Norrbyhallen",
      startTime: "15:30",
      endTime: "17:00",
      locationText: "Norrbyhallen",
    });
    await session(DEMO_CARPOOL_IDS.svkFriendlyMatch, 2, {
      kind: "match",
      title: "Träningsmatch mot Norrby VK",
      opponent: "Norrby VK",
      startTime: "09:00",
      endTime: "11:00",
      locationText: "Norrby sporthall",
    });
    await session(DEMO_CARPOOL_IDS.svkBeachTraining, 9, {
      kind: "other",
      kindLabel: "Beachvolley",
      title: "Beachvolley vid Hamnstranden",
      startTime: "14:00",
      endTime: "16:00",
      locationText: "Hamnstranden",
    });

    // The events are history, not news (as the governing step's): the seats
    // and decisions are shown where they live, not as unread notices.
    await env.db.withSystem("seed:carpools", {}, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`),
    );
  },
};
