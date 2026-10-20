// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isUuid, uuidv7 } from "./uuidv7.ts";

describe("uuidv7", () => {
  it("produces valid version 7 UUIDs with the timestamp in the first 48 bits", () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    const id = uuidv7(now);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(now);
  });

  it("is strictly increasing, also within one millisecond", () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7(1_800_000_000_000));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
