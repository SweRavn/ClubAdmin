// SPDX-License-Identifier: AGPL-3.0-only
// LOK-stöd under RF's rules of 22 May 2025 (P2.7 tests, item 2), with exact
// expectations, and the plugin through the conformance suite.

import { minimizePerson, type PluginPerson, type PluginSession } from "@clubadmin/plugin-api";
import { checkConformance, testContext } from "@clubadmin/plugin-api/testing";
import { describe, expect, it } from "vitest";

import { evaluatePeriodSessions, evaluateSessionAlone, RULES_2025_07_01, seLok } from "./index.ts";

let n = 0;
const id = () => `0199a000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const GROUP = "0199a000-0000-7000-8002-000000000001";

function person(birthDate: string | null, over: Partial<PluginPerson> = {}): PluginPerson {
  return {
    id: id(),
    givenName: "Test",
    familyName: "Person",
    birthDate,
    sex: "female",
    personalIdentityNumber: "201205012384",
    disability: false,
    membership: { status: "active", type: "active", joinedOn: "2020-01-01", leftOn: null },
    ...over,
  };
}

function session(
  date: string,
  participants: readonly PluginPerson[],
  leaders: readonly PluginPerson[],
  over: Partial<PluginSession> = {},
): PluginSession {
  return {
    id: id(),
    groupId: GROUP,
    sport: "fotboll",
    kind: "training",
    date,
    startsAt: `${date}T16:00:00Z`,
    durationMinutes: 60,
    participantIds: participants.map((p) => p.id),
    leaderIds: leaders.map((p) => p.id),
    ...over,
  };
}

const kids = (k: number, birthDate = "2014-05-01") =>
  Array.from({ length: k }, () => person(birthDate));
const coach = person("1985-01-01");
const alone = (s: PluginSession, people: PluginPerson[], minMinutes?: number) =>
  evaluateSessionAlone(s, people, minMinutes ? { minMinutes } : {});

describe("one group activity (§ 5)", () => {
  it("is outside the rules before 1 July 2025", () => {
    const k = kids(3);
    expect(alone(session("2025-06-30", k, [coach]), [...k, coach])).toMatchObject({
      counts: false,
      codes: ["lok.outside_rules"],
    });
    expect(alone(session("2025-07-01", k, [coach]), [...k, coach]).counts).toBe(true);
  });

  it("needs 45 minutes (60 in a municipal variant)", () => {
    const k = kids(3);
    expect(
      alone(session("2026-03-02", k, [coach], { durationMinutes: 44 }), [...k, coach]).codes,
    ).toEqual(["lok.too_short"]);
    expect(
      alone(session("2026-03-02", k, [coach], { durationMinutes: 45 }), [...k, coach]).counts,
    ).toBe(true);
    expect(
      alone(session("2026-03-02", k, [coach], { durationMinutes: 59 }), [...k, coach], 60).codes,
    ).toEqual(["lok.too_short"]);
    // A variant never makes it shorter than RF's.
    expect(
      alone(session("2026-03-02", k, [coach], { durationMinutes: 44 }), [...k, coach], 30).counts,
    ).toBe(false);
  });

  it("needs three participants who count", () => {
    const two = kids(2);
    const three = kids(3);
    expect(alone(session("2026-03-02", two, [coach]), [...two, coach]).codes).toEqual([
      "lok.too_few_participants",
    ]);
    expect(alone(session("2026-03-02", three, [coach]), [...three, coach]).counts).toBe(true);
  });

  it("needs a leader who turns 13 in the year; leaders 13–25 count as participants", () => {
    const k = kids(3);
    const twelve = person("2014-01-01"); // turns 12 in 2026
    const thirteen = person("2013-12-31"); // turns 13 in 2026
    expect(alone(session("2026-03-02", k, [twelve]), [...k, twelve]).codes).toEqual([
      "lok.no_leader",
    ]);
    const ok = alone(session("2026-03-02", k, [thirteen]), [...k, thirteen]);
    expect(ok.counts).toBe(true);
    expect(ok.countedPersonIds).toContain(thirteen.id);
    // An adult leader leads but gets no participant support.
    expect(alone(session("2026-03-02", k, [coach]), [...k, coach]).countedPersonIds).not.toContain(
      coach.id,
    );
  });

  it("counts ages by calendar year: 6 to 25, no upper age with a disability", () => {
    const six = person("2020-12-31"); // turns 6 in 2026
    const five = person("2021-01-01");
    const twentyFive = person("2001-12-31");
    const twentySix = person("2000-12-31");
    const adapted = person("1970-01-01", { disability: true });
    const s = session("2026-01-02", [six, five, twentyFive, twentySix, adapted], [coach]);
    const result = alone(s, [six, five, twentyFive, twentySix, adapted, coach]);
    expect(result.countedPersonIds.sort()).toEqual([six.id, twentyFive.id, adapted.id].sort());
    // A session of an adapted group counts adults too.
    const adults = [person("1980-01-01"), person("1981-01-01"), person("1982-01-01")];
    expect(
      alone(session("2026-03-02", adults, [coach], { adapted: true }), [...adults, coach]).counts,
    ).toBe(true);
  });

  it("supports at most 20 participants per leader present", () => {
    const k = kids(21);
    const one = alone(session("2026-03-02", k, [coach]), [...k, coach]);
    expect(one.countedPersonIds).toHaveLength(20);
    expect(one.codes).toEqual(["lok.over_leader_cap"]);
    const second = person("1990-01-01");
    const two = alone(session("2026-03-02", k, [coach, second]), [...k, coach, second]);
    expect(two.countedPersonIds).toHaveLength(21);
    expect(two.codes).toEqual([]);
  });

  it("does not count people who are not members", () => {
    const k = [...kids(3), person("2014-01-01", { membership: null })];
    expect(alone(session("2026-03-02", k, [coach]), [...k, coach]).countedPersonIds).toHaveLength(
      3,
    );
  });
});

describe("a period (§ 5 and § 6 across sessions)", () => {
  it("counts one group activity per person, sport and day; different sports both", () => {
    const k = kids(3);
    const people = [...k, coach];
    const morning = session("2026-03-02", k, [coach], { startsAt: "2026-03-02T08:00:00Z" });
    const evening = session("2026-03-02", k, [coach], { startsAt: "2026-03-02T17:00:00Z" });
    const swim = session("2026-03-02", k, [coach], {
      startsAt: "2026-03-02T19:00:00Z",
      sport: "simning",
    });
    const result = evaluatePeriodSessions([morning, evening, swim], people);
    expect(result.sessions.map((s) => s.countedPersonIds.length)).toEqual([3, 0, 3]);
    expect(result.people.find((p) => p.personId === k[0]!.id)).toEqual({
      personId: k[0]!.id,
      counted: 2,
      codes: ["lok.same_day"],
    });
  });

  it("caps 6–9 at 3 and 10–25 at 5 a calendar week, Monday to Sunday", () => {
    const young = kids(3, "2018-05-01"); // 8
    const older = kids(3, "2012-05-01"); // 14
    const people = [...young, ...older, coach];
    // Monday 2 March to Sunday 8 March 2026, then Monday 9 March.
    const days = ["02", "03", "04", "05", "06", "07", "08", "09"].map((d) => `2026-03-${d}`);
    const sessions = days.map((d) => session(d, [...young, ...older], [coach]));
    const result = evaluatePeriodSessions(sessions, people);
    const counted = (who: PluginPerson) => result.people.find((p) => p.personId === who.id)!;
    expect(counted(young[0]!)).toEqual({
      personId: young[0]!.id,
      counted: 4,
      codes: ["lok.week_cap"],
    });
    expect(counted(older[0]!)).toEqual({
      personId: older[0]!.id,
      counted: 6,
      codes: ["lok.week_cap"],
    });
    // Weights: 6–9 get 3+3+2 the first week, 10–25 get 3+3+2+1+1, then 3 each on Monday.
    const units = result.totals.find((t) => t.measure === "lok.units")!.value;
    expect(units).toBe(3 * (3 + 3 + 2) + 3 * (3 + 3 + 2 + 1 + 1) + 6 * 3);
  });

  it("does not let a leader lead two group activities at once", () => {
    const a = kids(3);
    const b = kids(3);
    const first = session("2026-03-02", a, [coach], { startsAt: "2026-03-02T16:00:00Z" });
    const second = session("2026-03-02", b, [coach], {
      startsAt: "2026-03-02T16:30:00Z",
      sport: "simning",
    });
    const result = evaluatePeriodSessions([first, second], [...a, ...b, coach]);
    expect(result.sessions[1]).toMatchObject({
      counts: false,
      codes: ["lok.no_leader", "lok.leader_overlap"],
    });
  });

  it("counts extra leader support for two or more leaders and lists missing data", () => {
    const k = [
      ...kids(3),
      person(null),
      person("2014-01-01", { personalIdentityNumber: null, sex: null }),
    ];
    const second = person("1990-01-01");
    const result = evaluatePeriodSessions(
      [session("2026-03-02", k, [coach, second])],
      [...k, coach, second],
    );
    expect(result.totals.find((t) => t.measure === "lok.extra_leader_support")!.value).toBe(1);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        { personId: k[3]!.id, field: "birthDate" },
        { personId: k[4]!.id, field: "personalIdentityNumber" },
        { personId: k[4]!.id, field: "sex" },
      ]),
    );
    expect(result.people.find((p) => p.personId === k[3]!.id)!.codes).toEqual([
      "lok.no_birth_date",
    ]);
  });

  it("chooses the rules by the activity's date (a later version beside the first)", () => {
    const later = { ...RULES_2025_07_01, validFrom: "2027-01-01", minParticipants: 4 };
    const versions = [RULES_2025_07_01, later];
    const k = kids(3, "2016-01-01");
    const people = [...k, coach];
    const result = evaluatePeriodSessions(
      [session("2026-12-31", k, [coach]), session("2027-01-04", k, [coach])],
      people,
      { versions },
    );
    expect(result.sessions.map((s) => s.counts)).toEqual([true, false]);
  });
});

describe("periods and deadlines (§ 7 and § 8)", () => {
  it("has two periods with the late reductions and refusal dates", async () => {
    const periods = await seLok.grantReporting!.periods(testContext(), "lok", 2026);
    expect(periods).toEqual([
      expect.objectContaining({
        key: "2026-1",
        deadline: "2026-08-25",
        late: [
          { until: "2026-09-01", percent: 25 },
          { until: "2026-09-15", percent: 50 },
          { until: "2026-09-30", percent: 75 },
        ],
        refusedAfter: "2026-09-30",
      }),
      expect.objectContaining({
        key: "2026-2",
        deadline: "2027-02-25",
        late: [
          { until: "2027-03-01", percent: 25 },
          { until: "2027-03-15", percent: 50 },
          { until: "2027-03-31", percent: 75 },
        ],
        refusedAfter: "2027-03-31",
      }),
    ]);
  });
});

describe("the plugin", () => {
  it("passes the conformance suite", async () => {
    const k = kids(5);
    const leaders = [coach, person("2009-01-01")];
    const people = [...k, ...leaders, person(null)];
    const sessions = ["2026-03-02", "2026-03-03", "2026-09-07"].map((d) =>
      session(d, [...k, people.at(-1)!], leaders),
    );
    expect(await checkConformance(seLok, { grants: { year: 2026, sessions, people } })).toEqual([]);
  });

  it("is given no personal identity number unless it declares it (it does, for the missing-data list)", () => {
    const p = person("2014-01-01");
    expect(minimizePerson(p, seLok.manifest.data)).toHaveProperty("personalIdentityNumber");
    expect(minimizePerson(p, seLok.manifest.data)).not.toHaveProperty("homeMunicipality");
  });

  it("exports the report as CSV and PDF", async () => {
    const k = kids(3);
    const people = [...k, coach];
    const s = session("2026-03-02", k, [coach]);
    const ctx = testContext();
    const [period] = await seLok.grantReporting!.periods(ctx, "lok", 2026);
    const evaluation = await seLok.grantReporting!.evaluatePeriod!(
      ctx,
      "lok",
      period!,
      [s],
      people,
    );
    const report = {
      id: "r",
      scheme: "lok",
      period: period!,
      evaluation,
      snapshot: null,
      people,
      sessions: [s],
    };
    const [file] = await seLok.grantReporting!.export(ctx, "lok", report, "csv");
    const text = Buffer.from(file!.content, "base64").toString("utf8");
    expect(text.split("\r\n")[0]).toBe("Datum;Idrott;Minuter;Räknas;Skäl;Person;Född");
    expect(text).toContain("2026-03-02;fotboll;60;ja;;Test Person;2014-05-01");
    expect(text).not.toContain("201205012384");
    const [pdf] = await seLok.grantReporting!.export(ctx, "lok", report, "pdf");
    expect(Buffer.from(pdf!.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });
});
