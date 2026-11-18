// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/require-await -- fake remotes and plugins answer at once */
// The host side of the contract (P2.7 tests, item 6): manifests, licences,
// contract versions, configuration, data minimisation, the logger, the
// network limit and contained failures.

import { z } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import {
  callPlugin,
  definePlugin,
  isSafeLogValue,
  minimizePerson,
  minimizeSession,
  PLUGIN_API_VERSION,
  pluginProblems,
  restrictedHttp,
  safeLogger,
  satisfiesApiRange,
  servesCountry,
  validateConfig,
} from "../src/index.ts";
import { deSport } from "./fixtures/de-sport.ts";
import { dkMembers } from "./fixtures/dk-members.ts";
import { nlYouth } from "./fixtures/nl-youth.ts";
import { person, session } from "./samples.ts";

describe("manifest", () => {
  it("accepts the fixtures", () => {
    for (const plugin of [dkMembers, deSport, nlYouth]) expect(pluginProblems(plugin)).toEqual([]);
  });

  it("refuses a licence that may not be combined with AGPL code", () => {
    const plugin = { ...dkMembers, manifest: { ...dkMembers.manifest, licence: "Proprietary" } };
    expect(pluginProblems(plugin)).toContain("licence Proprietary is not allowed for a plugin");
  });

  it("refuses an incompatible contract version at start", () => {
    const plugin = { ...dkMembers, manifest: { ...dkMembers.manifest, pluginApi: "^2.0.0" } };
    expect(pluginProblems(plugin)[0]).toMatch(/plugin API \^2\.0\.0/);
  });

  it("refuses texts missing in a locale and capabilities that are not implemented", () => {
    const { nb: _nb, ...rest } = dkMembers.manifest.texts;
    const missing = {
      ...dkMembers,
      manifest: { ...dkMembers.manifest, texts: { ...rest, nb: { "dk.scheme": "x" } } },
    };
    expect(pluginProblems(missing)).toContain("texts in nb do not have the same keys as sv");
    const noImpl = { manifest: dkMembers.manifest };
    expect(pluginProblems(noImpl)[0]).toMatch(/grant-reporting is declared/);
  });

  it("refuses an invalid id and an unknown data field", () => {
    expect(() => definePlugin({ manifest: { ...dkMembers.manifest, id: "Not Valid" } })).toThrow();
    expect(() =>
      definePlugin({ manifest: { ...dkMembers.manifest, data: ["shoeSize" as never] } }),
    ).toThrow();
  });

  it("matches contract versions", () => {
    expect(satisfiesApiRange("^1.0.0", "1.4.2")).toBe(true);
    expect(satisfiesApiRange("^1.2.0", "1.1.9")).toBe(false);
    expect(satisfiesApiRange("1.0.0", "1.0.1")).toBe(false);
    expect(satisfiesApiRange("^1.0.0", "2.0.0")).toBe(false);
    expect(satisfiesApiRange(`^${PLUGIN_API_VERSION}`)).toBe(true);
  });

  it("knows which countries a plugin serves", () => {
    expect(servesCountry(nlYouth, "NL")).toBe(true);
    expect(servesCountry(deSport, "DE")).toBe(true);
    expect(servesCountry(deSport, "SE")).toBe(false);
  });
});

describe("configuration", () => {
  it("validates per field and refuses unknown keys", () => {
    expect(validateConfig(deSport.manifest.config, { lsb: "blsv" })).toEqual({
      ok: true,
      values: { lsb: "blsv" },
    });
    expect(validateConfig(deSport.manifest.config, {})).toEqual({
      ok: false,
      problems: ["lsb: required"],
    });
    expect(validateConfig(deSport.manifest.config, { lsb: "other", x: 1 })).toEqual({
      ok: false,
      problems: ["x: unknown", "lsb: not one of the options"],
    });
    expect(validateConfig(nlYouth.manifest.config, { municipality: "36" })).toEqual({
      ok: false,
      problems: ["municipality: does not match"],
    });
  });
});

describe("data minimisation", () => {
  it("gives a plugin only what it declares", () => {
    const full = person();
    expect(minimizePerson(full, ["birthDate"])).toEqual({ id: full.id, birthDate: full.birthDate });
    // No personal identity number without declaring it.
    expect(minimizePerson(full, dkMembers.manifest.data)).not.toHaveProperty(
      "personalIdentityNumber",
    );
    expect(minimizePerson(full, ["personalIdentityNumber"]).personalIdentityNumber).toBe(
      full.personalIdentityNumber,
    );
    // Groups: the sport without the functions, and the other way round.
    expect(minimizePerson(full, ["groupSport"]).groups).toEqual([
      { groupId: full.groups![0]!.groupId, functions: [], sport: "football" },
    ]);
    expect(minimizePerson(full, ["groupRoles"]).groups).toEqual([
      { groupId: full.groups![0]!.groupId, functions: ["member"] },
    ]);
  });

  it("gives sessions without attendance unless declared", () => {
    const s = session({ participantIds: [person().id], leaderIds: [person().id] });
    expect(minimizeSession(s, [])).not.toHaveProperty("participantIds");
    expect(minimizeSession(s, ["attendance"]).participantIds).toHaveLength(1);
    expect(minimizeSession(s, ["attendance"])).not.toHaveProperty("leaderIds");
  });
});

describe("logging and network", () => {
  it("redacts personal data in log fields", () => {
    const lines: unknown[] = [];
    const redacted: string[] = [];
    const log = safeLogger(
      (level, event, fields) => lines.push({ level, event, fields }),
      (_e, f) => redacted.push(f),
    );
    log.info("report.evaluated", {
      club: "0199a000-0000-7000-8001-000000000001",
      sessions: 12,
      name: "Anna Lindqvist",
      pnr: "201205012384",
      email: "anna@example.test",
      code: "lok.too_short",
    });
    expect(lines).toEqual([
      {
        level: "info",
        event: "report.evaluated",
        fields: {
          club: "0199a000-0000-7000-8001-000000000001",
          sessions: 12,
          name: "[redacted]",
          pnr: "[redacted]",
          email: "[redacted]",
          code: "lok.too_short",
        },
      },
    ]);
    expect(redacted).toEqual(["name", "pnr", "email"]);
    expect(isSafeLogValue("se-lok:2026-1")).toBe(true);
  });

  it("reaches only declared hosts over HTTPS", async () => {
    const refused: string[] = [];
    const http = restrictedHttp(
      ["api.example.org"],
      async () => ({ status: 200, headers: {}, body: "ok" }),
      (h) => refused.push(h),
    );
    await expect(http.request("https://api.example.org/x")).resolves.toMatchObject({ body: "ok" });
    await expect(http.request("http://api.example.org/x")).rejects.toThrow();
    await expect(http.request("https://evil.example/x")).rejects.toThrow();
    await expect(http.request("https://user@api.example.org/x")).rejects.toThrow();
    expect(refused).toEqual(["api.example.org", "evil.example", "api.example.org"]);
  });
});

describe("calls", () => {
  it("contains a thrown error", async () => {
    const result = await callPlugin(async () => {
      throw new TypeError("boom: Anna");
    }, z.string());
    // The detail is the error's name only, never its message (which may hold personal data).
    expect(result).toMatchObject({ ok: false, error: "plugin_failed", detail: "TypeError" });
  });

  it("abandons a call that takes too long", async () => {
    const result = await callPlugin(() => new Promise(() => undefined), z.string(), 20);
    expect(result).toMatchObject({ ok: false, error: "plugin_timeout" });
  });

  it("refuses output that does not match the contract", async () => {
    const result = await callPlugin(async () => ({ not: "a string" }), z.string());
    expect(result).toMatchObject({ ok: false, error: "plugin_invalid_output" });
  });

  it("returns valid output", async () => {
    await expect(callPlugin(async () => "fine", z.string())).resolves.toMatchObject({
      ok: true,
      value: "fine",
    });
  });
});
