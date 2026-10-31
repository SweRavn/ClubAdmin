// SPDX-License-Identifier: AGPL-3.0-only
import type { ScheduleEntry } from "../api/queries.ts";
import { PREFETCH_ACTIVITIES, prefetchTargets } from "./prefetch.ts";

const now = Date.parse("2026-11-02T10:00:00Z");
const entry = (n: number, hours: number, extra: Partial<ScheduleEntry> = {}) =>
  ({
    activityId: `a${n}`,
    startsAt: new Date(now + hours * 3_600_000).toISOString(),
    endsAt: new Date(now + (hours + 1) * 3_600_000).toISOString(),
    responseMode: "requested",
    eventId: null,
    ...extra,
  }) as unknown as ScheduleEntry;

describe("prefetchTargets", () => {
  it("takes the coming week, soonest first, at most a dozen; answers only where asked", () => {
    const entries = [
      entry(1, 50),
      entry(2, -5), // ended
      entry(3, 2, { responseMode: "none", eventId: "e1" }),
      entry(4, 8 * 24), // next week
      ...Array.from({ length: 20 }, (_, i) => entry(10 + i, 60 + i)),
    ];
    const targets = prefetchTargets(entries, now);
    expect(targets.activities[0]).toBe("a3");
    expect(targets.activities).toHaveLength(PREFETCH_ACTIVITIES);
    expect(targets.activities).not.toContain("a2");
    expect(targets.activities).not.toContain("a4");
    expect(targets.answers).not.toContain("a3");
    expect(targets.events).toEqual(["e1"]);
  });
});
