// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { expandSeries, localDate, RecurrenceError, zonedTime } from "./recurrence.ts";

describe("zonedTime", () => {
  it("keeps local times across the DST changes in Stockholm and Oslo", () => {
    for (const zone of ["Europe/Stockholm", "Europe/Oslo"]) {
      // Winter time (UTC+1) before the change on 30 March 2025, summer (UTC+2) after.
      expect(zonedTime("2025-03-27", "18:00", zone).toISOString()).toBe("2025-03-27T17:00:00.000Z");
      expect(zonedTime("2025-04-03", "18:00", zone).toISOString()).toBe("2025-04-03T16:00:00.000Z");
      // Back to winter time on 26 October 2025.
      expect(zonedTime("2025-10-23", "18:00", zone).toISOString()).toBe("2025-10-23T16:00:00.000Z");
      expect(zonedTime("2025-10-30", "18:00", zone).toISOString()).toBe("2025-10-30T17:00:00.000Z");
    }
  });

  it("refuses a local time that does not exist and picks the first of an ambiguous one", () => {
    expect(() => zonedTime("2025-03-30", "02:30", "Europe/Stockholm")).toThrow(RecurrenceError);
    expect(zonedTime("2025-10-26", "02:30", "Europe/Stockholm").toISOString()).toBe(
      "2025-10-26T00:30:00.000Z",
    );
  });

  it("finds the local date of an instant", () => {
    expect(localDate(new Date("2025-06-01T22:30:00Z"), "Europe/Stockholm")).toBe("2025-06-02");
  });
});

describe("expandSeries", () => {
  const base = {
    slots: [
      { weekday: 2, startTime: "17:30", durationMinutes: 90 },
      { weekday: 4, startTime: "18:00", durationMinutes: 90 },
    ],
    startsOn: "2025-08-19",
    endsOn: "2025-09-04",
    skipDates: ["2025-08-28"],
    holidays: new Set<string>(),
    timeZone: "Europe/Stockholm",
  };

  it("makes the weekday sessions in order, without the skipped dates", () => {
    const { sessions, skipped } = expandSeries(base);
    expect(sessions.map((s) => s.date)).toEqual([
      "2025-08-19",
      "2025-08-21",
      "2025-08-26",
      "2025-09-02",
      "2025-09-04",
    ]);
    expect(skipped).toEqual([{ date: "2025-08-28", holiday: false }]);
    expect(sessions[0]!.startsAt.toISOString()).toBe("2025-08-19T15:30:00.000Z");
    expect(sessions[0]!.endsAt.toISOString()).toBe("2025-08-19T17:00:00.000Z");
  });

  it("skips public holidays when asked", () => {
    const { sessions, skipped } = expandSeries({
      ...base,
      startsOn: "2025-06-01",
      endsOn: "2025-06-10",
      skipDates: [],
      slots: [{ weekday: 5, startTime: "18:00", durationMinutes: 60 }],
      holidays: new Set(["2025-06-06"]),
    });
    expect(sessions).toHaveLength(0);
    expect(skipped).toEqual([{ date: "2025-06-06", holiday: true }]);
  });

  it("refuses two slots on one weekday and series longer than 400 days", () => {
    expect(() =>
      expandSeries({ ...base, slots: [base.slots[0]!, { ...base.slots[0]!, startTime: "19:00" }] }),
    ).toThrow(expect.objectContaining({ code: "invalid_recurrence" }) as unknown);
    expect(() => expandSeries({ ...base, endsOn: "2026-12-31" })).toThrow(
      expect.objectContaining({ code: "series_too_long" }) as unknown,
    );
  });
});
