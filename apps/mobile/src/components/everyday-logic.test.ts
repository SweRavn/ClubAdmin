// SPDX-License-Identifier: AGPL-3.0-only
// The logic of the everyday actions (P2.7g): the title from the kind, the
// call-up's left-out list, the activity's body, the return-time default,
// the sessions waiting for attendance, who announcements may go to, and the
// API's field errors.

import { ApiError } from "@clubadmin/api-client";

import {
  activityBody,
  activityValuesOf,
  defaultReturnTime,
  errorsByField,
  followTitle,
  kindTitle,
  leftOut,
  newActivityValues,
  timeOnDay,
} from "./activity-logic.ts";
import { announceGroups, mayAnnounceToClub } from "./announcement-logic.ts";
import { isLeaderFunction, waitingSessions } from "./attendance-logic.ts";
import { formErrorsOf } from "./form.tsx";

const titles = { training: "Träning", match: "Match", meeting: "Möte", other: "Övrigt" };
const zone = "Europe/Stockholm";

describe("title from kind", () => {
  it("is the kind's name, or what 'other' is called", () => {
    expect(kindTitle("match", "", titles)).toBe("Match");
    expect(kindTitle("other", " Lunch ", titles)).toBe("Lunch");
    expect(kindTitle("other", "", titles)).toBe("Övrigt");
  });

  it("follows the kind until the person writes a title", () => {
    expect(followTitle("Match", "Match", "Träning", titles)).toBe("Träning");
    expect(followTitle("", "Match", "Möte", titles)).toBe("Möte");
    expect(followTitle("Lunch", "Lunch", "Match", titles)).toBe("Match");
    expect(followTitle("Cupfinal", "Match", "Träning", titles)).toBe("Cupfinal");
  });

  it("is sent as the kind's name when the title is left empty", () => {
    const v = { ...newActivityValues(new Date("2026-11-26T10:00:00Z"), zone, titles), title: "" };
    const result = activityBody(v, zone, titles, false);
    expect("body" in result && result.body.title).toBe("Match");
  });
});

describe("call-up", () => {
  it("lists those offered but not ticked, once", () => {
    expect(leftOut(["a", "b", "c", "b"], new Set(["a"]))).toEqual(["b", "c"]);
    expect(leftOut(["a"], new Set(["a"]))).toEqual([]);
  });
});

describe("activity body", () => {
  const base = newActivityValues(new Date("2026-11-26T10:00:00Z"), zone, titles);

  it("turns local times in the club's zone into UTC", () => {
    const result = activityBody({ ...base, meetTime: "17:30" }, zone, titles, false);
    if (!("body" in result)) throw new Error("expected a body");
    expect(result.body.startsAt).toBe("2026-11-27T17:00:00.000Z");
    expect(result.body.endsAt).toBe("2026-11-27T18:30:00.000Z");
    expect(result.body.meetAt).toBe("2026-11-27T16:30:00.000Z");
    expect(result.body).not.toHaveProperty("opponent");
  });

  it("finds an end before the start and a deadline after it", () => {
    const result = activityBody(
      { ...base, endTime: "17:00", respondByDate: "2026-11-28" },
      zone,
      titles,
      false,
    );
    expect("fields" in result && errorsByField(result.fields)).toEqual({
      endTime: "event_period_invalid",
      respondByDate: "respond_by_after_start",
    });
  });

  it("clears empty fields when changing", () => {
    const result = activityBody(base, zone, titles, true);
    if (!("body" in result)) throw new Error("expected a body");
    expect(result.body.opponent).toBeNull();
    expect(result.body.locationId).toBeNull();
    expect(result.body).not.toHaveProperty("allDay");
  });

  it("reads an activity back into the form's values", () => {
    const v = activityValuesOf(
      {
        kind: "training",
        title: "Träning",
        startsAt: "2026-06-01T16:00:00Z",
        endsAt: "2026-06-01T17:30:00Z",
        allDay: false,
        meetAt: null,
        meetPlace: null,
        location: { id: "loc" },
        locationText: null,
        opponent: null,
        homeAway: null,
        competition: null,
        carpoolReturnMinutes: 20,
        notes: null,
      },
      zone,
    );
    expect([v.date, v.startTime, v.endTime, v.locationId, v.carpoolReturnMinutes]).toEqual([
      "2026-06-01",
      "18:00",
      "19:30",
      "loc",
      "20",
    ]);
  });
});

describe("return-time default", () => {
  it("is the car pool's defaultReturnAt in the club's zone", () => {
    expect(defaultReturnTime("2026-11-27T18:50:00Z", "2026-11-27T18:30:00Z", zone)).toBe("19:50");
  });

  it("falls back to the end plus the minutes", () => {
    expect(defaultReturnTime(undefined, "2026-11-27T18:30:00Z", zone)).toBe("19:45");
    expect(defaultReturnTime(null, "2026-11-27T18:30:00Z", zone, 20)).toBe("19:50");
    expect(defaultReturnTime(null, null, zone)).toBe("");
  });

  it("puts a time on the activity's day, the way home never before the start", () => {
    const start = "2026-11-27T22:00:00Z"; // 23:00 local
    expect(timeOnDay("22:30", start, zone)).toBe("2026-11-27T21:30:00.000Z");
    expect(timeOnDay("00:30", start, zone, start)).toBe("2026-11-27T23:30:00.000Z");
    expect(timeOnDay("", start, zone)).toBeNull();
  });
});

describe("attendance waiting", () => {
  it("lists started sessions without marks, newest first, once", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const sessions = [
      { activityId: "a", startsAt: "2026-11-20T17:00:00Z", recorded: false },
      { activityId: "b", startsAt: "2026-11-25T17:00:00Z", recorded: false },
      { activityId: "c", startsAt: "2026-11-24T17:00:00Z", recorded: true },
      { activityId: "d", startsAt: "2026-11-27T17:00:00Z", recorded: false },
      { activityId: "b", startsAt: "2026-11-25T17:00:00Z", recorded: false },
    ];
    expect(waitingSessions(sessions, now).map((s) => s.activityId)).toEqual(["b", "a"]);
  });

  it("takes leaders, not members or the physio", () => {
    expect(["member", "physio", "head_coach", "team_manager"].map(isLeaderFunction)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe("announcement targets", () => {
  const groups = [
    { id: "g1", name: "F2017" },
    { id: "g2", name: "P2015" },
  ];

  it("are the groups with the group permission", () => {
    const p = {
      permissions: [],
      groups: [{ groupId: "g1", permissions: ["group.announcements.send"] }],
    };
    expect(mayAnnounceToClub(p)).toBe(false);
    expect(announceGroups(p, groups)).toEqual([{ id: "g1", name: "F2017" }]);
  });

  it("are every group and the club with the club permission", () => {
    const p = { permissions: ["club.announcements.send"], groups: [] };
    expect(mayAnnounceToClub(p)).toBe(true);
    expect(announceGroups(p, groups)).toHaveLength(2);
  });
});

describe("form errors", () => {
  it("takes each field's first code and the form's detail code", () => {
    const error = new ApiError(
      422,
      {
        type: "https://example.test/problems#validation",
        title: "Invalid",
        status: 422,
        requestId: "r",
        detail: "invalid_input",
        errors: [
          { location: "body", path: "title", code: "too_small", message: "x" },
          { location: "body", path: "title", code: "too_big", message: "x" },
          { location: "body", path: "notCalledUp[0]", code: "invalid_format", message: "x" },
        ],
      },
      undefined,
    );
    expect(formErrorsOf(error)).toEqual({
      form: "invalid_input",
      fields: { title: "too_small", notCalledUp: "invalid_format" },
    });
    expect(formErrorsOf(null)).toEqual({ form: null, fields: {} });
    expect(formErrorsOf(new Error("offline")).form).toBe("failed");
  });
});
