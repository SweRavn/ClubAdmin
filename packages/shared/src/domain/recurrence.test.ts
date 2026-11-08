// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  expandRule,
  formatRRule,
  RecurrenceRuleError,
  requestAt,
  ruleDates,
  ruleProblem,
  type SeriesRule,
} from "./recurrence.ts";

const zone = "Europe/Stockholm";
const none = new Set<string>();
const dates = (rule: SeriesRule, from: string, to: string, startsOn = from, slots = []) =>
  ruleDates(rule, slots, startsOn, from, to);
const monthly = (byDay: SeriesRule["byDay"], interval = 1): SeriesRule => ({
  freq: "monthly",
  interval,
  byDay,
  startTime: "10:00",
  durationMinutes: 60,
});

describe("ruleDates", () => {
  it("weekly: every week and every other week, counted from the first date's week", () => {
    const slots = [
      { weekday: 1, startTime: "17:30", durationMinutes: 90 },
      { weekday: 3, startTime: "18:00", durationMinutes: 60 },
    ];
    expect(
      ruleDates({ freq: "weekly", interval: 1 }, slots, "2026-03-04", "2026-03-04", "2026-03-16"),
    ).toEqual(["2026-03-04", "2026-03-09", "2026-03-11", "2026-03-16"]);
    // Every other week from the week of Wednesday 4 March (Monday 2 March).
    expect(
      ruleDates({ freq: "weekly", interval: 2 }, slots, "2026-03-04", "2026-03-04", "2026-03-31"),
    ).toEqual(["2026-03-04", "2026-03-16", "2026-03-18", "2026-03-30"]);
    // A window starting later keeps the same weeks.
    expect(
      ruleDates({ freq: "weekly", interval: 2 }, slots, "2026-03-04", "2026-03-10", "2026-03-20"),
    ).toEqual(["2026-03-16", "2026-03-18"]);
  });

  it("monthly by position: first Wednesday, second and fourth Tuesday, last Friday", () => {
    expect(dates(monthly([{ weekday: 3, ordinal: 1 }]), "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-07",
      "2026-02-04",
      "2026-03-04",
      "2026-04-01",
    ]);
    expect(
      dates(
        monthly([
          { weekday: 2, ordinal: 2 },
          { weekday: 2, ordinal: 4 },
        ]),
        "2026-03-01",
        "2026-03-31",
      ),
    ).toEqual(["2026-03-10", "2026-03-24"]);
    expect(dates(monthly([{ weekday: 5, ordinal: -1 }]), "2026-01-01", "2026-03-31")).toEqual([
      "2026-01-30",
      "2026-02-27",
      "2026-03-27",
    ]);
  });

  it("monthly by day skips months without the day; intervals cross the year end", () => {
    const rule: SeriesRule = {
      freq: "monthly",
      interval: 1,
      byMonthDay: [31],
      startTime: "19:00",
      durationMinutes: 60,
    };
    expect(dates(rule, "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
    ]);
    const quarterly = { ...rule, interval: 3, byMonthDay: [15] };
    expect(dates(quarterly, "2026-11-01", "2027-06-30", "2026-11-01")).toEqual([
      "2026-11-15",
      "2027-02-15",
      "2027-05-15",
    ]);
  });

  it("daily every n days, from the first date", () => {
    const rule: SeriesRule = {
      freq: "daily",
      interval: 3,
      startTime: "09:00",
      durationMinutes: 120,
    };
    expect(dates(rule, "2026-12-30", "2027-01-08", "2026-12-28")).toEqual([
      "2026-12-31",
      "2027-01-03",
      "2027-01-06",
    ]);
  });

  it("refuses rules that do not fit", () => {
    expect(ruleProblem({ freq: "weekly", interval: 1 }, [])).toBe("no_slots");
    expect(
      ruleProblem({ freq: "monthly", interval: 1, startTime: "10:00", durationMinutes: 60 }, []),
    ).toBe("monthly_by");
    expect(
      ruleProblem({ freq: "daily", interval: 0, startTime: "10:00", durationMinutes: 60 }, []),
    ).toBe("interval");
    expect(() => dates({ freq: "daily", interval: 1 }, "2026-01-01", "2026-01-02")).toThrow(
      RecurrenceRuleError,
    );
  });
});

describe("expandRule", () => {
  it("keeps local times across DST, skips dates and holidays, stops at the end date", () => {
    const { sessions, skipped } = expandRule({
      rule: { freq: "weekly", interval: 1 },
      slots: [{ weekday: 7, startTime: "10:00", durationMinutes: 60 }],
      startsOn: "2026-03-22",
      endsOn: "2026-04-12",
      from: "2026-03-22",
      to: "2026-12-31",
      skipDates: ["2026-04-05"],
      holidays: new Set(["2026-04-12"]),
      timeZone: zone,
    });
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-03-22T09:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
    ]);
    expect(skipped).toEqual([
      { date: "2026-04-05", holiday: false },
      { date: "2026-04-12", holiday: true },
    ]);
  });

  it("an open-ended series runs to the window", () => {
    const { sessions } = expandRule({
      rule: monthly([{ weekday: 6, ordinal: 1 }]),
      slots: [],
      startsOn: "2026-01-01",
      endsOn: null,
      from: "2026-01-01",
      to: "2026-12-31",
      skipDates: [],
      holidays: none,
      timeZone: zone,
    });
    expect(sessions).toHaveLength(12);
  });

  it("refuses a local time skipped by the spring change", () => {
    expect(() =>
      expandRule({
        rule: { freq: "daily", interval: 1, startTime: "02:30", durationMinutes: 60 },
        slots: [],
        startsOn: "2026-03-29",
        endsOn: "2026-03-29",
        from: "2026-03-29",
        to: "2026-03-29",
        skipDates: [],
        holidays: none,
        timeZone: zone,
      }),
    ).toThrow("nonexistent_local_time");
  });
});

describe("formatRRule", () => {
  it("writes the RFC 5545 subset", () => {
    expect(
      formatRRule(
        { freq: "weekly", interval: 2 },
        [
          { weekday: 3, startTime: "18:00", durationMinutes: 60 },
          { weekday: 1, startTime: "17:30", durationMinutes: 90 },
        ],
        null,
      ),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
    expect(formatRRule(monthly([{ weekday: 5, ordinal: -1 }]), [], "2026-06-30")).toBe(
      "FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20260630",
    );
  });
});

describe("requestAt", () => {
  const start = new Date("2026-03-11T17:00:00Z"); // Wednesday 18:00 in Stockholm (CET)

  it("N days before at a local time, or N hours before", () => {
    expect(requestAt({ kind: "days", days: 3, time: "18:00" }, start, zone)?.toISOString()).toBe(
      "2026-03-08T17:00:00.000Z",
    );
    expect(requestAt({ kind: "hours", hours: 24 }, start, zone)?.toISOString()).toBe(
      "2026-03-10T17:00:00.000Z",
    );
    expect(requestAt(null, start, zone)).toBeNull();
  });

  it("the same day, at a time after the start, is the start", () => {
    expect(requestAt({ kind: "days", days: 0, time: "20:00" }, start, zone)).toEqual(start);
  });

  it("across the spring change the local time is kept", () => {
    // Wednesday 1 April 18:00 CEST; three days before is Sunday 29 March (the change).
    const april = new Date("2026-04-01T16:00:00Z");
    expect(requestAt({ kind: "days", days: 3, time: "18:00" }, april, zone)?.toISOString()).toBe(
      "2026-03-29T16:00:00.000Z",
    );
  });
});
