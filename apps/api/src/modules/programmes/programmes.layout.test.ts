// SPDX-License-Identifier: AGPL-3.0-only
// The rules of templates and laying out (P2.9): local times across daylight
// saving time, slots, refusals and warnings, a template's own checks.

import { describe, expect, it } from "vitest";

import { DomainError } from "../../platform/domain/domain-error.ts";
import {
  addDays,
  instantOf,
  layOut,
  slotMapping,
  storedItemsOf,
  templateFromSource,
} from "./programmes.layout.ts";

const TZ = "Europe/Stockholm";
const G1 = "0199a000-0000-7000-8000-0000000000a1";
const G2 = "0199a000-0000-7000-8000-0000000000a2";
const HALL = "0199a000-0000-7000-8000-0000000000b1";
const TYPE = "0199a000-0000-7000-8000-0000000000c1";

const activity = (id: string, startsAt: string, endsAt: string, groupIds = [G1]) => ({
  id,
  kind: "match" as const,
  kindLabel: null,
  title: "Match",
  notes: null,
  locationId: HALL,
  locationText: null,
  startsAt: new Date(startsAt),
  endsAt: new Date(endsAt),
  meetAt: null,
  meetPlace: null,
  transportMode: null,
  homeAway: null,
  opponent: null,
  responseMode: "requested" as const,
  groupIds,
});

const facts = {
  timeZone: TZ,
  now: new Date("2026-11-28T12:00:00Z"),
  groups: new Map([
    [G1, { archived: false }],
    [G2, { archived: false }],
  ]),
  locations: new Map([[HALL, { archived: false }]]),
  dutyRefusals: new Map<string, string>(),
  existing: [],
};

describe("templateFromSource", () => {
  it("keeps local times and days from the first local day; one slot per group", () => {
    const content = templateFromSource(
      {
        activities: [
          activity("a1", "2027-01-16T08:00:00Z", "2027-01-16T09:00:00Z"),
          activity("a2", "2027-01-17T23:30:00Z", "2027-01-18T00:30:00Z", [G1, G2]),
        ],
        shifts: [
          {
            id: "s1",
            groupId: G1,
            dutyTypeId: TYPE,
            title: "Kiosk",
            note: null,
            startsAt: new Date("2027-01-16T07:00:00Z"),
            endsAt: new Date("2027-01-16T10:00:00Z"),
            locationId: null,
            needed: 2,
            activityId: "a1",
          },
        ],
      },
      TZ,
      new Map([
        [G1, "P2012"],
        [G2, "P2013"],
      ]),
    );
    expect(content.dayCount).toBe(3);
    expect(content.slots.map((s) => [s.key, s.label])).toEqual([
      ["g1", "P2012"],
      ["g2", "P2013"],
    ]);
    const [first, second, shift] = content.items;
    expect(first).toMatchObject({ dayOffset: 0, startTime: "09:00", endTime: "10:00" });
    // 00:30 local on the 18th: the third day.
    expect(second).toMatchObject({
      dayOffset: 2,
      startTime: "00:30",
      endDayOffset: 2,
      slotKeys: ["g1", "g2"],
    });
    expect(shift).toMatchObject({ kind: "duty_shift", parentItemId: first!.id, needed: 2 });
  });

  it("refuses an empty source", () => {
    expect(() => templateFromSource({ activities: [], shifts: [] }, TZ, new Map())).toThrow(
      DomainError,
    );
  });
});

describe("laying out", () => {
  const template = {
    dayCount: 2,
    slots: [{ key: "g1", label: "Lag 1", defaultGroupId: G1 }],
    items: storedItemsOf(
      [
        {
          ref: "m1",
          kind: "activity",
          parentRef: null,
          dayOffset: 0,
          startTime: "09:00",
          endDayOffset: 0,
          endTime: "10:00",
          slotKeys: ["g1"],
          title: "Match",
          activityKind: "match",
          kindLabel: null,
          notes: null,
          locationId: HALL,
          locationText: null,
          meetMinutesBefore: 30,
          meetPlace: null,
          transportMode: null,
          homeAway: null,
          opponent: null,
          responseMode: null,
          dutyTypeId: null,
          needed: null,
        },
        {
          ref: "m2",
          kind: "activity",
          parentRef: null,
          dayOffset: 1,
          startTime: "09:00",
          endDayOffset: 1,
          endTime: "10:00",
          slotKeys: ["g1"],
          title: "Match",
          activityKind: "match",
          kindLabel: null,
          notes: null,
          locationId: HALL,
          locationText: null,
          meetMinutesBefore: null,
          meetPlace: null,
          transportMode: null,
          homeAway: null,
          opponent: null,
          responseMode: null,
          dutyTypeId: null,
          needed: null,
        },
        {
          ref: "k",
          kind: "duty_shift",
          parentRef: "m1",
          dayOffset: 0,
          startTime: "08:30",
          endDayOffset: 0,
          endTime: "10:00",
          slotKeys: [],
          title: "Sekretariat",
          activityKind: null,
          kindLabel: null,
          notes: null,
          locationId: null,
          locationText: null,
          meetMinutesBefore: null,
          meetPlace: null,
          transportMode: null,
          homeAway: null,
          opponent: null,
          responseMode: null,
          dutyTypeId: TYPE,
          needed: 1,
        },
      ],
      [{ key: "g1", label: "Lag 1", defaultGroupId: G1 }],
      2,
    ),
  };

  it("keeps 09:00 local across the start of summer time", () => {
    const mapping = slotMapping(template.slots, {}, () => true);
    const layout = layOut(
      template,
      null,
      { firstDay: "2027-03-27", slots: mapping, locations: {} },
      facts,
    );
    expect(layout.items.map((i) => i.startsAt.toISOString())).toEqual([
      "2027-03-27T08:00:00.000Z",
      "2027-03-28T07:00:00.000Z",
      "2027-03-27T07:30:00.000Z",
    ]);
    expect(layout.items[0]!.meetAt?.toISOString()).toBe("2027-03-27T07:30:00.000Z");
    // The shift follows its activity's group.
    expect(layout.items[2]!.groupIds).toEqual([G1]);
    expect(layout.refusals).toEqual([]);
  });

  it("refuses an activity whose slot has no group, warns about the slot", () => {
    const mapping = slotMapping(template.slots, { g1: [] }, () => true);
    const layout = layOut(
      template,
      null,
      { firstDay: "2027-03-27", slots: mapping, locations: {} },
      facts,
    );
    expect(layout.warnings.map((w) => w.code)).toContain("slot_without_group");
    expect(layout.refusals.map((r) => r.code)).toEqual([
      "activity_without_group",
      "activity_without_group",
    ]);
  });

  it("refuses archived places and duty types; warns about conflicts and past dates", () => {
    const layout = layOut(
      template,
      null,
      { firstDay: "2026-01-10", slots: slotMapping(template.slots, {}, () => true), locations: {} },
      {
        ...facts,
        locations: new Map([[HALL, { archived: true }]]),
        dutyRefusals: new Map([[TYPE, "duty_type_archived"]]),
        existing: [
          {
            id: "x",
            locationId: HALL,
            startsAt: new Date("2026-01-10T08:30:00Z"),
            endsAt: new Date("2026-01-10T09:30:00Z"),
          },
        ],
      },
    );
    expect(layout.refusals.map((r) => r.code).sort()).toEqual([
      "duty_type_archived",
      "location_archived",
      "location_archived",
    ]);
    expect(layout.warnings.map((w) => w.code).sort()).toEqual(["location_conflict", "past_date"]);
  });

  it("maps a slot to its default group only when it may be used", () => {
    expect(slotMapping(template.slots, {}, () => false).get("g1")).toEqual([]);
    expect(slotMapping(template.slots, { g1: [G2, G2] }, () => true).get("g1")).toEqual([G2]);
  });
});

describe("a template's items", () => {
  it("refuse a day past the template's and a shift without a type", () => {
    const base = template0();
    expect(() => storedItemsOf([{ ...base, dayOffset: 3, endDayOffset: 3 }], [], 2)).toThrow(
      "programme_day_offset_invalid",
    );
    expect(() => storedItemsOf([{ ...base, kind: "duty_shift", dutyTypeId: null }], [], 2)).toThrow(
      "invalid_input",
    );
    expect(() => storedItemsOf([{ ...base, slotKeys: ["nope"] }], [], 2)).toThrow(
      "programme_slot_unknown",
    );
  });
});

describe("time helpers", () => {
  it("add days and turn a skipped local time into the next hour", () => {
    expect(addDays("2027-03-27", 1)).toBe("2027-03-28");
    // 02:30 does not exist on 28 March 2027 in Stockholm.
    expect(instantOf("2027-03-28", "02:30", TZ).toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });
});

function template0() {
  return {
    ref: "a",
    kind: "activity" as const,
    parentRef: null,
    dayOffset: 0,
    startTime: "10:00",
    endDayOffset: 0,
    endTime: "11:00",
    slotKeys: [] as string[],
    title: "Träning",
    activityKind: "training" as const,
    kindLabel: null,
    notes: null,
    locationId: null,
    locationText: null,
    meetMinutesBefore: null,
    meetPlace: null,
    transportMode: null,
    homeAway: null,
    opponent: null,
    responseMode: null,
    dutyTypeId: null as string | null,
    needed: null,
  };
}
