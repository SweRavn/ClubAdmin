// SPDX-License-Identifier: AGPL-3.0-only
import { appRoute } from "./push.ts";

const id = "0192f7a0-0000-7000-8000-000000000001";

describe("appRoute", () => {
  it("opens activities and events, the family page in settings, the inbox otherwise", () => {
    expect(appRoute(`/activities/${id}`)).toBe(`/activities/${id}`);
    expect(appRoute(`/events/${id}`)).toBe(`/events/${id}`);
    expect(appRoute("/me/family")).toBe("/settings/family");
    expect(appRoute(`/clubs/${id}/members/exports`)).toBe("/notifications");
    expect(appRoute(`/activities/${id}/../../admin`)).toBe("/notifications");
  });
});
