// SPDX-License-Identifier: AGPL-3.0-only
// Demo activities (P1.4, docs/seed-data.md): locations, weekly training
// series from ten weeks ago to six weeks ahead (public holidays skipped),
// three matches per team, a joint training in IKN, and the cases the
// calendars should show: a skipped week, a cancelled session, a session
// moved to another hall (detached) and a series split from a date on.
// Everything goes through the activities service, as the API would.

import type { CreateSeriesInput } from "@clubadmin/shared";

import type { ActivitiesService } from "../../modules/activities/index.ts";
import type { DemoStep } from "../environment.ts";

/** Fixed IDs of the demo locations and series. */
export const DEMO_ACTIVITY_IDS = {
  strandvikenHall: "0199a000-0000-7000-8013-000000000001",
  strandvikenSchool: "0199a000-0000-7000-8013-000000000002",
  norrbackaIp: "0199a000-0000-7000-8013-000000000003",
  norrbackaHall: "0199a000-0000-7000-8013-000000000004",
  fjordvikTurf: "0199a000-0000-7000-8013-000000000005",
  svkF2017Series: "0199a000-0000-7000-8014-000000000001",
  svkHerrSeries: "0199a000-0000-7000-8014-000000000002",
  svkHerrWinter: "0199a000-0000-7000-8014-000000000003",
  iknP2012Series: "0199a000-0000-7000-8014-000000000004",
  iknF2015Series: "0199a000-0000-7000-8014-000000000005",
  filJ2014Series: "0199a000-0000-7000-8014-000000000006",
  /** An extra F2017 session that started half an hour before seeding (taking attendance, P1.5). */
  svkF2017Extra: "0199a000-0000-7000-8015-000000000001",
} as const;

const DAY_MS = 86_400_000;

export const activitiesDemoStep: DemoStep = {
  name: "activities",
  async run(env, _data, core) {
    const s = env.services;
    const id = (key: string) => {
      const value = core.ids.get(key);
      if (!value) throw new Error(`no id for ${key}`);
      return value;
    };
    const as = (person: string, club: string) => ({
      actorKind: "person" as const,
      personId: id(person),
      clubId: id(club),
      requestId: "seed:demo",
    });
    const today = env.clock.day("now");
    const date = (offset: number) => env.clock.day(`${offset < 0 ? "-" : "+"}${Math.abs(offset)}d`);
    /** The date of an ISO weekday in the week `weeks` from this one. */
    const weekday = (weeks: number, iso: number) => {
      const now = Date.parse(`${today}T00:00:00Z`);
      const current = new Date(now).getUTCDay() || 7;
      return new Date(now + (iso - current + weeks * 7) * DAY_MS).toISOString().slice(0, 10);
    };
    const at = (day: string, time: string) => `${day}T${time}:00Z`;
    const ten = weekday(-10, 1);
    const six = weekday(6, 7);

    // --- Strandvikens VK (Anna) -------------------------------------------------------
    const anna = as("anna", "svk");
    await s.activities.createLocation(
      anna,
      {
        name: "Strandvikens sporthall",
        street: "Idrottsvägen 4",
        postalCode: "451 50",
        city: "Strandviken",
        latitude: 58.3504,
        longitude: 11.9389,
        directions: "Ingång B, hall 2",
      },
      { id: DEMO_ACTIVITY_IDS.strandvikenHall },
    );
    await s.activities.createLocation(
      anna,
      { name: "Strandvikens skola, gymnastiksalen", street: "Skolgatan 1", city: "Strandviken" },
      { id: DEMO_ACTIVITY_IDS.strandvikenSchool },
    );
    // F2017: two days with different times; one week skipped (the autumn break, four weeks ago).
    await series(s.activities, anna, id("svk-f2017"), DEMO_ACTIVITY_IDS.svkF2017Series, {
      title: "Träning",
      slots: [
        { weekday: 2, startTime: "17:30", durationMinutes: 60 },
        { weekday: 4, startTime: "18:00", durationMinutes: 75 },
      ],
      startsOn: ten,
      endsOn: six,
      skipDates: [weekday(-4, 2), weekday(-4, 4)],
      skipPublicHolidays: true,
      locationId: DEMO_ACTIVITY_IDS.strandvikenHall,
      notes: "Ta med vattenflaska och inneskor.",
      leaderNotes: "Bollvagnen står i förrådet, koden är 1932.",
    });
    const f2017 = await sessions(s.activities, anna, id("svk-f2017"), date(1), date(42));
    // Next week's Tuesday: the hall is taken by the municipality.
    const taken = f2017.find((a) => a.occurrenceOn === weekday(1, 2));
    if (taken) {
      await s.activities.cancelActivity(anna, taken.id, {
        reason: "Hallen är upptagen av kommunen",
      });
    }
    // The Thursday after: moved to the school's gym (detached from the series).
    const moved = f2017.find((a) => a.occurrenceOn === weekday(1, 4));
    if (moved) {
      await s.activities.updateActivity(anna, moved.id, {
        locationId: DEMO_ACTIVITY_IDS.strandvikenSchool,
        notes: "Flyttad till gymnastiksalen i skolan denna vecka.",
      });
    }
    // Herr senior: a winter schedule from two weeks ahead (split: later and longer).
    await series(s.activities, anna, id("svk-herr"), DEMO_ACTIVITY_IDS.svkHerrSeries, {
      title: "Träning herr",
      slots: [
        { weekday: 1, startTime: "20:00", durationMinutes: 90 },
        { weekday: 3, startTime: "20:00", durationMinutes: 90 },
      ],
      startsOn: ten,
      endsOn: six,
      skipPublicHolidays: true,
      locationId: DEMO_ACTIVITY_IDS.strandvikenHall,
    });
    const herr = await sessions(s.activities, anna, id("svk-herr"), weekday(2, 1), date(42));
    if (herr[0]) {
      await s.activities.splitSeries(
        anna,
        DEMO_ACTIVITY_IDS.svkHerrSeries,
        {
          activityId: herr[0].id,
          title: "Träning herr (vinterschema)",
          slots: [
            { weekday: 1, startTime: "20:30", durationMinutes: 90 },
            { weekday: 3, startTime: "20:30", durationMinutes: 90 },
          ],
        },
        { id: DEMO_ACTIVITY_IDS.svkHerrWinter },
      );
    }
    await matches(s.activities, anna, id("svk-f2017"), date, DEMO_ACTIVITY_IDS.strandvikenHall, [
      ["Seriematch mot Kustens VK", "home", null],
      ["Seriematch mot Älvdalens VBK", "away", "Älvdalshallen, Älvdalen"],
      ["Poolspel F10", "neutral", "Göteborg, Valhalla sporthall"],
    ]);
    await matches(s.activities, anna, id("svk-herr"), date, DEMO_ACTIVITY_IDS.strandvikenHall, [
      ["Division 2: Kustens VK", "away", "Kusthallen"],
      ["Division 2: Hisingens VK", "home", null],
      ["Division 2: Lerums VBK", "home", null],
    ]);
    // An extra session going on as the demo is seeded: attendance can be taken at once.
    const started = env.clock.now.getTime() - 30 * 60_000;
    await s.activities.createActivity(
      anna,
      id("svk-f2017"),
      {
        kind: "training",
        title: "Extrapass inför matchen",
        startsAt: new Date(started).toISOString(),
        endsAt: new Date(started + 75 * 60_000).toISOString(),
        locationId: DEMO_ACTIVITY_IDS.strandvikenHall,
      },
      { id: DEMO_ACTIVITY_IDS.svkF2017Extra },
    );
    await s.activities.createActivity(anna, id("svk-f2017"), {
      kind: "meeting",
      title: "Föräldramöte inför vårsäsongen",
      startsAt: at(date(16), "17:00"),
      endsAt: at(date(16), "18:00"),
      locationId: DEMO_ACTIVITY_IDS.strandvikenSchool,
    });

    // --- IK Norrbacka (Karin) -------------------------------------------------------
    const karin = as("karin", "ikn");
    await s.activities.createLocation(
      karin,
      {
        name: "Norrbacka IP",
        street: "Idrottsplatsvägen 2",
        city: "Norrbacka",
        latitude: 63.1792,
        longitude: 14.6357,
      },
      { id: DEMO_ACTIVITY_IDS.norrbackaIp },
    );
    await s.activities.createLocation(
      karin,
      {
        name: "Norrbackahallen",
        street: "Hallvägen 7",
        city: "Norrbacka",
        directions: "Plan 2, hall A",
      },
      { id: DEMO_ACTIVITY_IDS.norrbackaHall },
    );
    await series(s.activities, karin, id("ikn-p2012"), DEMO_ACTIVITY_IDS.iknP2012Series, {
      title: "Fotbollsträning",
      slots: [
        { weekday: 1, startTime: "17:00", durationMinutes: 90 },
        { weekday: 3, startTime: "17:00", durationMinutes: 90 },
      ],
      startsOn: ten,
      endsOn: six,
      skipPublicHolidays: true,
      locationId: DEMO_ACTIVITY_IDS.norrbackaIp,
    });
    await series(s.activities, karin, id("ikn-f2015"), DEMO_ACTIVITY_IDS.iknF2015Series, {
      title: "Innebandyträning",
      slots: [{ weekday: 2, startTime: "16:30", durationMinutes: 60 }],
      startsOn: ten,
      endsOn: six,
      skipPublicHolidays: true,
      locationId: DEMO_ACTIVITY_IDS.norrbackaHall,
    });
    // A joint training of the two groups (Saturday next week, in the hall).
    await s.activities.createActivity(karin, id("ikn-p2012"), {
      kind: "training",
      title: "Gemensam träning P/F",
      startsAt: at(weekday(1, 6), "09:00"),
      endsAt: at(weekday(1, 6), "10:30"),
      locationId: DEMO_ACTIVITY_IDS.norrbackaHall,
      groupIds: [id("ikn-f2015")],
      notes: "Fotboll och innebandy tränar tillsammans: ta med både inne- och utekläder.",
    });
    await matches(s.activities, karin, id("ikn-p2012"), date, DEMO_ACTIVITY_IDS.norrbackaIp, [
      ["Seriematch mot Östersunds FK P", "home", null],
      ["Seriematch mot Frösö IF", "away", "Frösö IP"],
      ["Cup: Jämtlandscupen", "neutral", "Östersund, Jämtkraft arena"],
    ]);
    await matches(s.activities, karin, id("ikn-f2015"), date, DEMO_ACTIVITY_IDS.norrbackaHall, [
      ["Poolspel innebandy", "neutral", "Brunflohallen"],
      ["Match mot Krokoms IBK", "home", null],
      ["Match mot Lits IBK", "away", "Lits sporthall"],
    ]);

    // --- Fjordvik IL (Lars) -----------------------------------------------------------
    const lars = as("lars", "fil");
    await s.activities.createLocation(
      lars,
      {
        name: "Fjordvik kunstgress",
        street: "Idrettsveien 3",
        postalCode: "6800",
        city: "Fjordvik",
        latitude: 61.4506,
        longitude: 5.8572,
      },
      { id: DEMO_ACTIVITY_IDS.fjordvikTurf },
    );
    await series(s.activities, lars, id("fil-j2014"), DEMO_ACTIVITY_IDS.filJ2014Series, {
      title: "Fotballtrening",
      slots: [
        { weekday: 2, startTime: "17:30", durationMinutes: 75 },
        { weekday: 4, startTime: "17:30", durationMinutes: 75 },
      ],
      startsOn: ten,
      endsOn: six,
      skipPublicHolidays: true,
      locationId: DEMO_ACTIVITY_IDS.fjordvikTurf,
    });
    await matches(s.activities, lars, id("fil-j2014"), date, DEMO_ACTIVITY_IDS.fjordvikTurf, [
      ["Seriekamp mot Førde IL", "home", null],
      ["Seriekamp mot Sogndal J", "away", "Fosshaugane Campus"],
      ["Turnering: Fjordcupen", "neutral", "Florø"],
    ]);
  },
};

type Tenant = Parameters<ActivitiesService["createSeries"]>[0];

function series(
  activities: ActivitiesService,
  ctx: Tenant,
  groupId: string,
  id: string,
  input: CreateSeriesInput,
): Promise<unknown> {
  return activities.createSeries(ctx, groupId, input, { id });
}

/** The group's sessions in a range of dates. */
async function sessions(
  activities: ActivitiesService,
  ctx: Tenant,
  groupId: string,
  from: string,
  to: string,
) {
  const page = await activities.groupCalendar(ctx, groupId, {
    from: `${from}T00:00:00Z`,
    to: `${to}T23:59:59Z`,
    limit: 500,
  });
  return page.items.map((v) => v.activity);
}

/** Three matches: two weeks ago, in five days and in three weeks; home matches at `home`. */
async function matches(
  activities: ActivitiesService,
  ctx: Tenant,
  groupId: string,
  date: (offset: number) => string,
  home: string,
  list: [title: string, homeAway: "home" | "away" | "neutral", place: string | null][],
): Promise<void> {
  const offsets = [-14, 5, 19];
  for (const [i, [title, homeAway, place]] of list.entries()) {
    const day = date(offsets[i]!);
    await activities.createActivity(ctx, groupId, {
      kind: "match",
      title,
      homeAway,
      startsAt: `${day}T10:00:00Z`,
      endsAt: `${day}T11:30:00Z`,
      meetAt: `${day}T09:15:00Z`,
      meetPlace: homeAway === "away" ? "Samling vid klubbhuset" : null,
      ...(place ? { locationText: place } : { locationId: home }),
    });
  }
}
