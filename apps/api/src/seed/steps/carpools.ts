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

import type { ActorContext, TenantContext } from "@clubadmin/db";

import { CarpoolsService } from "../../modules/carpools/index.ts";
import type { DemoStep } from "../environment.ts";

/** Fixed IDs of the demo car pools. */
export const DEMO_CARPOOL_IDS = {
  awayGround: "0199a000-0000-7000-8013-000000000010",
  awayMatch: "0199a000-0000-7000-8015-000000000010",
  pastMatch1: "0199a000-0000-7000-8015-000000000011",
  pastMatch2: "0199a000-0000-7000-8015-000000000012",
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
    await s.carpools.setSettings(as("goran"), "0199a000-0000-7000-8013-000000000003");
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
  },
};
