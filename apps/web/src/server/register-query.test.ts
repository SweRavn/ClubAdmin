// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { registerParams, toQueryString } from "./register-query.ts";

describe("registerParams", () => {
  it("keeps valid filters and drops the rest", () => {
    expect(
      registerParams(
        { q: " els ", status: ["active", "paused"], bornFrom: "abc", sort: "joined", extra: "x" },
        "full",
      ),
    ).toEqual({ q: "els", status: "active,paused", sort: "joined" });
  });

  it("keeps only the board's filters for the limited register", () => {
    const params = registerParams(
      { q: "a", bornFrom: "2010", missingConsent: "marketing", sort: "joined", type: "active" },
      "limited",
    );
    expect(params).toEqual({ q: "a", type: "active" });
    expect(toQueryString(params)).toBe("q=a&type=active");
  });
});
