// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ClientInfoResponseSchema, compareVersions, parseFeatureFlags } from "./client.ts";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0", "1.0.0", 0],
    ["1.10.0", "1.9.9", 1],
    ["1.2.3", "1.3", -1],
    ["2", "1.99.99", 1],
  ])("%s vs %s → %d", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("parseFeatureFlags", () => {
  it("reads bare names as on and ignores invalid entries", () => {
    expect(parseFeatureFlags("chat, calendar=false,beta=on, Bad Name ,")).toEqual({
      chat: true,
      calendar: false,
      beta: true,
    });
    expect(parseFeatureFlags(undefined)).toEqual({});
  });
});

describe("ClientInfoResponseSchema", () => {
  it("accepts features and flags it does not know (newer servers)", () => {
    const parsed = ClientInfoResponseSchema.parse({
      apiVersion: 1,
      serverVersion: "9.0.0",
      apps: {
        ios: { minimumVersion: "1.0.0", recommendedVersion: "1.0.0", storeUrl: null },
        android: { minimumVersion: "1.0.0", recommendedVersion: "1.0.0", storeUrl: null },
      },
      features: ["something.new"],
      flags: { unknown: true },
      addedLater: "ignored",
    });
    expect(parsed.features).toEqual(["something.new"]);
  });
});
