// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { formFieldOf } from "./form-fields.ts";

const apiFields = {
  startsAt: "startDate",
  groupIds: "groupId",
  "activities.*.startsAt": "a.*.startTime",
};
const form = new Set(["title", "startDate", "groupId", "a.0.title", "a.1.startTime", "q.0.label"]);

describe("formFieldOf (P2.7d)", () => {
  it("maps a field, a list's row and an index in brackets", () => {
    expect(formFieldOf("startsAt", apiFields, form)).toBe("startDate");
    expect(formFieldOf("activities.1.startsAt", apiFields, form)).toBe("a.1.startTime");
    expect(formFieldOf("activities[1].startsAt", apiFields, form)).toBe("a.1.startTime");
    expect(formFieldOf("title", apiFields, form)).toBe("title");
  });

  it("falls back to the form's own fields: a list's first row, or the singular", () => {
    expect(formFieldOf("groupIds.0", {}, form)).toBe("groupId");
    expect(formFieldOf("a", {}, form)).toBe("a.0.title");
    expect(formFieldOf("q.0.label", {}, form)).toBe("q.0.label");
    expect(formFieldOf("q.3.label", {}, form)).toBe("q.0.label");
  });

  it("keeps the name when nothing matches (the summary lists it) and without a form", () => {
    expect(formFieldOf("unknown", {}, form)).toBe("unknown");
    expect(formFieldOf("startsAt", apiFields, new Set())).toBe("startDate");
    expect(formFieldOf("", apiFields, form)).toBeNull();
  });
});
