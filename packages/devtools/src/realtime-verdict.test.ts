// SPDX-License-Identifier: AGPL-3.0-only
// What `pnpm dev:smoke` says about the chat's real-time route (P2.7c).
import { describe, expect, it } from "vitest";

import { realtimeVerdict } from "./smoke.ts";

const ORIGIN = "https://clubadmin.localhost";
const UPSTREAM = "host.docker.internal:4000";

describe("realtimeVerdict", () => {
  it("passes when the API refuses the test ticket", () => {
    expect(realtimeVerdict({ kind: "upgraded", closeCode: 4401 }, ORIGIN, UPSTREAM)).toContain(
      "the API answered",
    );
    expect(realtimeVerdict({ kind: "http", status: 401, body: "" }, ORIGIN, UPSTREAM)).toContain(
      "the API answered",
    );
  });

  it("names the origin the API refuses", () => {
    expect(() => realtimeVerdict({ kind: "upgraded", closeCode: 4403 }, ORIGIN, UPSTREAM)).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it("says when Caddy cannot reach the API", () => {
    expect(() =>
      realtimeVerdict({ kind: "http", status: 502, body: "" }, ORIGIN, UPSTREAM),
    ).toThrow(/host\.docker\.internal:4000/);
  });

  it("says when the route goes to the web app (an old Caddyfile)", () => {
    expect(() =>
      realtimeVerdict({ kind: "http", status: 404, body: "" }, ORIGIN, UPSTREAM),
    ).toThrow(/pnpm dev:services/);
  });
});
