// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@clubadmin/api-client";

import { retryDelay, shouldRetry } from "./query-client.ts";

describe("query retries", () => {
  it("retries 429 after Retry-After, not other client errors", () => {
    const limited = new ApiError(429, undefined, undefined, 7);
    expect(shouldRetry(0, limited)).toBe(true);
    expect(retryDelay(0, limited)).toBe(7000);
    expect(shouldRetry(0, new ApiError(404, undefined, undefined))).toBe(false);
    expect(shouldRetry(0, new ApiError(503, undefined, undefined))).toBe(true);
    expect(shouldRetry(2, new TypeError("Network request failed"))).toBe(false);
  });
});
