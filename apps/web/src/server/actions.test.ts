// SPDX-License-Identifier: AGPL-3.0-only
// The event forms say what is wrong per field (P2.7c).
import { describe, expect, it } from "vitest";

import { FORM_ACTIONS } from "./actions.ts";

const CLUB = "0199a000-0000-7000-8001-000000000001";

const form = (values: Record<string, string>) => {
  const data = new FormData();
  data.set("clubId", CLUB);
  data.set("timeZone", "Europe/Stockholm");
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
};

describe("event forms with field errors (P2.7c)", () => {
  const create = FORM_ACTIONS["create-event"]!;

  it("names the missing title and start date", () => {
    expect(create.call(form({ title: "", startDate: "" }))).toEqual({
      invalid: "invalid_input",
      fields: { title: "required", startDate: "required" },
    });
  });

  it("names a date or time that is not one", () => {
    expect(
      create.call(form({ title: "Höstfest", startDate: "2026-13-40x", startTime: "25:00" })),
    ).toEqual({
      invalid: "invalid_input",
      fields: { startDate: "invalid_date", startTime: "invalid_time" },
    });
  });

  it("puts an end before the start on the end", () => {
    expect(
      create.call(
        form({ title: "Höstfest", startDate: "2026-12-01", startTime: "18:00", endTime: "17:00" }),
      ),
    ).toEqual({ invalid: "event_period_invalid", fields: { endTime: "event_period_invalid" } });
  });

  it("names a capacity that is not a whole number above zero", () => {
    expect(create.call(form({ title: "Läger", startDate: "2026-12-01", capacity: "0" }))).toEqual({
      invalid: "invalid_input",
      fields: { capacity: "invalid_number" },
    });
  });

  it("maps the API's request fields to the form's", () => {
    expect(create.apiFields).toMatchObject({ startsAt: "startDate", endsAt: "endDate" });
    expect(FORM_ACTIONS["update-event"]!.apiFields).toBe(create.apiFields);
  });
});
