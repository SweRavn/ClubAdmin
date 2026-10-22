// SPDX-License-Identifier: AGPL-3.0-only
import type { ClientInfo } from "../api/queries.ts";
import { hasFeature, storeUrl, updateState } from "./client-info.ts";

const info = (min: string, recommended: string): ClientInfo => ({
  apiVersion: 1,
  serverVersion: "1.0.0",
  apps: {
    ios: { minimumVersion: min, recommendedVersion: recommended, storeUrl: null },
    android: {
      minimumVersion: min,
      recommendedVersion: recommended,
      storeUrl: "https://play.example/app",
    },
  },
  features: ["sessions.mobile", "something.newer"],
  flags: {},
});

describe("updateState", () => {
  it("requires an update below the minimum and suggests one below the recommendation", () => {
    expect(updateState(info("1.2.0", "1.4.0"), "android", "1.1.9")).toBe("required");
    expect(updateState(info("1.2.0", "1.4.0"), "ios", "1.3.0")).toBe("recommended");
    expect(updateState(info("1.2.0", "1.4.0"), "ios", "1.10.0")).toBe("ok");
    // Without an answer (offline, first start) nothing blocks the app.
    expect(updateState(undefined, "ios", "0.0.1")).toBe("ok");
    expect(storeUrl(info("1", "1"), "android")).toBe("https://play.example/app");
  });
});

describe("hasFeature", () => {
  it("uses what the server lists, and the baseline without an answer", () => {
    expect(hasFeature(info("1", "1"), "sessions.mobile")).toBe(true);
    expect(hasFeature(info("1", "1"), "me.preferences")).toBe(false);
    expect(hasFeature(undefined, "me.preferences")).toBe(true);
    expect(hasFeature(undefined, "sessions.mobile")).toBe(false);
  });
});
