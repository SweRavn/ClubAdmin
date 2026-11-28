// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@clubadmin/api-client";

import { isServerReachable, isUnreachable, noteResult } from "./server-status.ts";

describe("server status", () => {
  it("tells no answer from an answer", () => {
    expect(isUnreachable(new TypeError("Network request failed"))).toBe(true);
    expect(isUnreachable(new ApiError(503, undefined, undefined))).toBe(true);
    expect(isUnreachable(new ApiError(404, undefined, undefined))).toBe(false);
    expect(isUnreachable(new Error("empty response"))).toBe(false);
  });

  it("is unreachable after a failed request and reachable after any answer", () => {
    noteResult(new TypeError("Network request failed"));
    expect(isServerReachable()).toBe(false);
    noteResult(new ApiError(403, undefined, undefined));
    expect(isServerReachable()).toBe(true);
    noteResult(new TypeError("Network request failed"));
    noteResult(null);
    expect(isServerReachable()).toBe(true);
  });
});
