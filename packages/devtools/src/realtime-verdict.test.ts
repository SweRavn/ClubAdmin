// SPDX-License-Identifier: AGPL-3.0-only
// What `pnpm dev:smoke` says about the chat's real-time route (P2.7c).
import { describe, expect, it } from "vitest";

import { realtimeVerdict } from "./smoke.ts";

const ORIGIN = "https://clubadmin.localhost";
const UPSTREAM = "host.docker.internal:4000";

describe("realtimeVerdict", () => {
  it("passes when the API refuses the test ticket", () => {
    expect(realtimeVerdict({ kind: "upgraded", closeCode: 4401 }, ORIGIN, UPSTREAM).status).toBe(
      "ok",
    );
    expect(realtimeVerdict({ kind: "http", status: 401, body: "" }, ORIGIN, UPSTREAM).status).toBe(
      "ok",
    );
  });

  it("names the origin the API refuses", () => {
    const verdict = realtimeVerdict({ kind: "upgraded", closeCode: 4403 }, ORIGIN, UPSTREAM);
    expect(verdict.status).toBe("fail");
    expect(verdict.fix).toContain("CORS_ORIGINS");
  });

  it("only warns when the API is not running (services without the apps)", () => {
    const verdict = realtimeVerdict({ kind: "http", status: 502, body: "" }, ORIGIN, UPSTREAM);
    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("host.docker.internal:4000");
  });

  it("fails when the route goes to the web app (an old Caddyfile)", () => {
    const verdict = realtimeVerdict({ kind: "http", status: 404, body: "" }, ORIGIN, UPSTREAM);
    expect(verdict.status).toBe("fail");
    expect(verdict.fix).toContain("pnpm dev:services");
  });
});
