// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6, ADR 0050; docs/seed-data.md): IK Norrbacka's kiosk
// and score-table duty types, P2012's quota of two shifts per player this
// season, kiosk shifts at three home matches, Anna signed up for Oskar,
// Ahmed's shift offered to another family, an unstaffed score-table shift
// and a past shift still to be marked.

import { sql, type TenantContext } from "@clubadmin/db";

import { DutiesService } from "../../modules/duties/index.ts";
import type { DemoStep } from "../environment.ts";

const DAY_MS = 86_400_000;

/** Fixed IDs the request budgets and the e2e tests find. */
export const DEMO_DUTY_IDS = {
  homeMatch: "0199a000-0000-7000-8015-000000000020",
} as const;

export const dutiesDemoStep: DemoStep = {
  name: "duties",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`duties seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const clubId = id("ikn");
    const teamId = id("ikn-p2012");
    const as = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId,
      requestId: "seed:duties",
    });
    const now = env.clock.now.getTime();
    const date = (offset: number) => new Date(now + offset * DAY_MS).toISOString().slice(0, 10);

    // The catalogue (the club manager): the kiosk from 13, the score table from 15.
    const kiosk = await s.duties.createType(as("goran"), {
      name: "Kiosk",
      instruction: "Öppna kiosken en halvtimme före matchstart. Kassan finns i förrådet.",
      minAge: 13,
      childContact: "none",
    });
    const scoreTable = await s.duties.createType(as("goran"), {
      name: "Sekretariat",
      instruction: "Sköt matchklockan och protokollet tillsammans med domaren.",
      minAge: 15,
      childContact: "with_children",
    });

    // This season (August to July), two shifts per player in P2012.
    const year = Number(env.clock.day("now").slice(0, 4));
    const start = env.clock.day("now").slice(5, 7) >= "08" ? year : year - 1;
    const season = await s.groups.createSeason(as("goran"), {
      name: `${start}/${String(start + 1).slice(2)}`,
      startsOn: `${start}-08-01`,
      endsOn: `${start + 1}-07-31`,
    });
    await s.duties.putQuota(as("ahmed"), teamId, { seasonId: season.id, shiftsPerPlayer: 2 });

    // The first home match (its shifts show on the activity).
    await s.activities.createActivity(
      as("ahmed"),
      teamId,
      {
        kind: "match",
        title: "Hemmamatch mot Kalmarby IF",
        opponent: "Kalmarby IF",
        homeAway: "home",
        startsAt: `${date(3)}T15:00:00Z`,
        endsAt: `${date(3)}T16:45:00Z`,
      },
      { id: DEMO_DUTY_IDS.homeMatch },
    );

    // Kiosk shifts at three home matches, and the score table at the first.
    const group = { groupId: teamId };
    const shift = (
      offset: number,
      typeId: string,
      title: string,
      needed: number,
      activityId?: string,
    ) =>
      s.duties.createShift(as("ahmed"), group, {
        dutyTypeId: typeId,
        title,
        startsAt: `${date(offset)}T14:30:00Z`,
        endsAt: `${date(offset)}T17:00:00Z`,
        needed,
        note: "Hemmamatch på Norrbacka IP",
        ...(activityId ? { activityId } : {}),
      });
    const first = await shift(3, kiosk.id, "Kiosk – hemmamatch", 2, DEMO_DUTY_IDS.homeMatch);
    await shift(3, scoreTable.id, "Sekretariat – hemmamatch", 1, DEMO_DUTY_IDS.homeMatch);
    await shift(10, kiosk.id, "Kiosk – hemmamatch", 2);
    await shift(17, kiosk.id, "Kiosk – hemmamatch", 2);

    // Anna signs up for the first, counting for Oskar (her only player in P2012).
    await s.duties.signUp(as("anna"), { me: id("anna"), wardIds: [id("oskar")] }, first.id, {});
    // Ahmed signs up counting for Liam, then offers his shift to another family.
    const ahmeds = await s.duties.signUp(
      as("ahmed"),
      { me: id("ahmed"), wardIds: [id("liam")] },
      first.id,
      {},
    );
    await s.duties.createSwap(as("ahmed"), { me: id("ahmed"), wardIds: [id("liam")] }, ahmeds.id, {
      kind: "offer",
    });

    // Last Saturday's kiosk: Anna was on it, nobody has marked it yet ("Att markera").
    const before = new DutiesService(env.db, {
      clubs: s.clubs,
      now: () => new Date(now - 7 * DAY_MS),
    });
    const past = await before.createShift(as("ahmed"), group, {
      dutyTypeId: kiosk.id,
      title: "Kiosk – hemmamatch",
      startsAt: `${date(-5)}T14:30:00Z`,
      endsAt: `${date(-5)}T17:00:00Z`,
      needed: 1,
    });
    await before.assign(as("ahmed"), group, past.id, {
      personId: id("anna"),
      countsForPersonId: id("oskar"),
    });

    // SVK's catalogue (Anna, P2.7b): its coaches create shifts for home matches.
    const svk = id("svk");
    const asAnna: TenantContext = {
      actorKind: "person",
      personId: id("anna"),
      clubId: svk,
      requestId: "seed:duties",
    };
    await s.duties.createType(asAnna, {
      name: "Kiosk",
      instruction: "Öppna kiosken en halvtimme före första matchen. Växelkassan finns i förrådet.",
      minAge: 13,
      childContact: "none",
    });
    await s.duties.createType(asAnna, {
      name: "Sekretariat",
      instruction: "Sköt resultattavlan och matchprotokollet tillsammans med domaren.",
      minAge: 15,
      childContact: "with_children",
    });

    // The events are history, not news (as the other steps').
    await env.db.withSystem("seed:duties", {}, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`),
    );
  },
};
