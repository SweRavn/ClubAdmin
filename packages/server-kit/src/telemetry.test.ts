// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { scrubSpanAttributes } from "./telemetry-scrub.ts";

describe("scrubSpanAttributes", () => {
  it("removes query strings and personal-data attributes", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://clubadmin.localhost/api/v1/people?search=Anna",
      "http.target": "/api/v1/people?search=Anna",
      "url.query": "search=Anna",
      "http.request.method": "GET",
      "enduser.email": "anna@example.test",
      "db.system": "postgresql",
    };
    scrubSpanAttributes(attributes);
    expect(attributes).toEqual({
      "url.full": "https://clubadmin.localhost/api/v1/people",
      "http.target": "/api/v1/people",
      "http.request.method": "GET",
      "db.system": "postgresql",
    });
  });
});
