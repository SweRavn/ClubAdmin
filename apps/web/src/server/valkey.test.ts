// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isValkeyUnavailable } from "./valkey.ts";

describe("isValkeyUnavailable", () => {
  it("recognises a store that cannot be reached, and nothing else", () => {
    const retries = Object.assign(
      new Error("Reached the max retries per request limit (which is 5)."),
      {
        name: "MaxRetriesPerRequestError",
      },
    );
    expect(isValkeyUnavailable(retries)).toBe(true);
    expect(isValkeyUnavailable(new Error("connect ECONNREFUSED 127.0.0.1:6379"))).toBe(true);
    expect(isValkeyUnavailable(new Error("read ECONNRESET"))).toBe(true);
    expect(isValkeyUnavailable(new Error("Connection is closed."))).toBe(true);
    expect(isValkeyUnavailable(new TypeError("x is undefined"))).toBe(false);
    expect(isValkeyUnavailable("ECONNRESET")).toBe(false);
  });
});
