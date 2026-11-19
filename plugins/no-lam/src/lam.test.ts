// SPDX-License-Identifier: AGPL-3.0-only
// Samordnet rapportering, the basis of LAM (P2.7 tests, item 3): members on
// 31 December by age band and sex, people who joined or left around the
// date, paid and unpaid fees, active and passive members per sport, adapted
// groups and all-round sport, and the plugin through the conformance suite.

import type { PluginPerson } from "@clubadmin/plugin-api";
import { checkConformance, testContext } from "@clubadmin/plugin-api/testing";
import { describe, expect, it } from "vitest";

import { bandOf, noLam, snapshotOf } from "./index.ts";

let n = 0;
const id = () => `0199a000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const FOOTBALL = "0199a000-0000-7000-8002-000000000001";
const SKI = "0199a000-0000-7000-8002-000000000002";
const ADAPTED = "0199a000-0000-7000-8002-000000000003";
const ALLIDRETT = "0199a000-0000-7000-8002-000000000004";

function person(birthDate: string | null, over: Partial<PluginPerson> = {}): PluginPerson {
  return {
    id: id(),
    birthDate,
    sex: "female",
    disability: false,
    membership: { status: "active", type: "active", joinedOn: "2020-01-01", leftOn: null },
    membershipFeePaid: true,
    groups: [{ groupId: FOOTBALL, functions: ["member"], sport: "fotball", adapted: false }],
    ...over,
  };
}
const valueOf = (
  totals: { measure: string; dimensions: Record<string, string>; value: number }[],
  measure: string,
  dims: Record<string, string> = {},
) =>
  totals.find((t) => t.measure === measure && JSON.stringify(t.dimensions) === JSON.stringify(dims))
    ?.value ?? 0;

describe("age bands", () => {
  it("uses the age reached in the year: 0–5, 6–12, 13–19, 20–25, 26+", () => {
    expect([0, 5, 6, 12, 13, 19, 20, 25, 26, 80].map(bandOf)).toEqual([
      "0-5",
      "0-5",
      "6-12",
      "6-12",
      "13-19",
      "13-19",
      "20-25",
      "20-25",
      "26+",
      "26+",
    ]);
  });
});

describe("the snapshot on 31 December", () => {
  it("counts members by age band and sex, and the LAM target groups", () => {
    const people = [
      person("2014-12-31"), // 12 in 2026
      person("2013-01-01", { sex: "male" }), // 13
      person("2007-06-01"), // 19
      person("1990-01-01", { sex: "male" }),
    ];
    const s = snapshotOf(people, "2026-12-31");
    expect(valueOf(s.totals, "lam.members_total")).toBe(4);
    expect(valueOf(s.totals, "lam.members", { age: "6-12", sex: "female" })).toBe(1);
    expect(valueOf(s.totals, "lam.members", { age: "13-19", sex: "male" })).toBe(1);
    expect(valueOf(s.totals, "lam.members", { age: "13-19", sex: "female" })).toBe(1);
    expect(valueOf(s.totals, "lam.members", { age: "26+", sex: "male" })).toBe(1);
    expect(valueOf(s.totals, "lam.target", { group: "6-12" })).toBe(1);
    expect(valueOf(s.totals, "lam.target", { group: "13-19" })).toBe(2);
  });

  it("counts those who joined by and left after the date, not the others", () => {
    const joinedOnDate = person("2014-01-01", {
      membership: { status: "active", type: "active", joinedOn: "2026-12-31", leftOn: null },
    });
    const joinedAfter = person("2014-01-01", {
      membership: { status: "active", type: "active", joinedOn: "2027-01-02", leftOn: null },
    });
    const leftAfter = person("2014-01-01", {
      membership: { status: "left", type: "active", joinedOn: "2020-01-01", leftOn: "2027-01-15" },
    });
    const leftBefore = person("2014-01-01", {
      membership: { status: "left", type: "active", joinedOn: "2020-01-01", leftOn: "2026-12-30" },
    });
    const s = snapshotOf([joinedOnDate, joinedAfter, leftAfter, leftBefore], "2026-12-31");
    expect(s.people.map((p) => p.personId).sort()).toEqual([joinedOnDate.id, leftAfter.id].sort());
  });

  it("leaves out unpaid fees and flags fees the club does not keep", () => {
    const unpaid = person("2014-01-01", { membershipFeePaid: false });
    const unknown = person("2014-01-01", { membershipFeePaid: null });
    const s = snapshotOf([unpaid, unknown], "2026-12-31");
    expect(valueOf(s.totals, "lam.members_total")).toBe(1);
    expect(s.people).toEqual(
      [
        { personId: unpaid.id, codes: ["lam.fee_unpaid"] },
        { personId: unknown.id, codes: ["lam.counted", "lam.fee_unknown", "lam.active_counted"] },
      ].sort((a, b) => a.personId.localeCompare(b.personId)),
    );
  });

  it("counts active members once per sport; passive members only as members", () => {
    const twoSports = person("2012-01-01", {
      groups: [
        { groupId: FOOTBALL, functions: ["member"], sport: "fotball" },
        { groupId: SKI, functions: ["member"], sport: "ski" },
        { groupId: SKI, functions: ["head_coach"], sport: "ski" },
      ],
    });
    const passive = person("1980-01-01", {
      membership: { status: "active", type: "passive", joinedOn: "2020-01-01", leftOn: null },
    });
    const coach = person("1985-01-01", {
      sex: "male",
      groups: [{ groupId: FOOTBALL, functions: ["head_coach"], sport: "fotball" }],
    });
    const s = snapshotOf([twoSports, passive, coach], "2026-12-31");
    expect(valueOf(s.totals, "lam.active", { sport: "fotball", age: "13-19", sex: "female" })).toBe(
      1,
    );
    expect(valueOf(s.totals, "lam.active", { sport: "ski", age: "13-19", sex: "female" })).toBe(1);
    expect(valueOf(s.totals, "lam.active", { sport: "fotball", age: "26+", sex: "male" })).toBe(1);
    expect(s.totals.filter((t) => t.measure === "lam.active")).toHaveLength(3);
    expect(valueOf(s.totals, "lam.members_total")).toBe(3);
  });

  it("counts adapted groups as members with a disability and all-round sport by its sport", () => {
    const para = person("2010-01-01", {
      groups: [{ groupId: ADAPTED, functions: ["member"], sport: "svømming", adapted: true }],
    });
    const small = person("2020-01-01", {
      groups: [{ groupId: ALLIDRETT, functions: ["member"], sport: "allidrett" }],
    });
    const s = snapshotOf([para, small], "2026-12-31", { allidrettSport: "allidrett" });
    expect(
      valueOf(s.totals, "lam.disability", { sport: "svømming", age: "13-19", sex: "female" }),
    ).toBe(1);
    expect(valueOf(s.totals, "lam.allidrett", { age: "6-12", sex: "female" })).toBe(1);
  });

  it("lists missing birth dates and sex", () => {
    const noBirth = person(null);
    const noSex = person("2014-01-01", { sex: null });
    const s = snapshotOf([noBirth, noSex], "2026-12-31");
    expect(s.missing).toEqual(
      [
        { personId: noBirth.id, field: "birthDate" },
        { personId: noSex.id, field: "sex" },
      ].sort((a, b) => a.personId.localeCompare(b.personId)),
    );
    expect(valueOf(s.totals, "lam.members", { age: "6-12", sex: "unspecified" })).toBe(1);
  });
});

describe("the plugin", () => {
  it("reports the year's figures by 30 April", async () => {
    expect(await noLam.grantReporting!.periods(testContext(), "samordnet", 2026)).toEqual([
      {
        key: "2026",
        from: "2026-01-01",
        to: "2026-12-31",
        referenceDate: "2026-12-31",
        deadline: "2027-04-30",
        late: [],
        refusedAfter: null,
      },
    ]);
  });

  it("passes the conformance suite", async () => {
    const people = [
      person("2014-01-01"),
      person("2009-01-01", { sex: "male" }),
      person(null),
      person("1980-01-01", { membershipFeePaid: null }),
    ];
    expect(
      await checkConformance(noLam, {
        club: { id: id(), country: "NO", timeZone: "Europe/Oslo", locale: "nb-NO" },
        config: { allidrettSport: "allidrett" },
        grants: { year: 2026, sessions: [], people },
      }),
    ).toEqual([]);
  });

  it("exports the figures as CSV and PDF", async () => {
    const ctx = testContext();
    const [period] = await noLam.grantReporting!.periods(ctx, "samordnet", 2026);
    const people = [person("2014-01-01")];
    const snapshot = await noLam.grantReporting!.snapshot!(ctx, "samordnet", period!, people);
    const report = {
      id: "r",
      scheme: "samordnet",
      period: period!,
      evaluation: null,
      snapshot,
      people,
      sessions: [],
    };
    const [file] = await noLam.grantReporting!.export(ctx, "samordnet", report, "csv");
    const text = Buffer.from(file!.content, "base64").toString("utf8");
    expect(text).toContain("Medlemmer per 31.12;;6-12;female;1");
    const [pdf] = await noLam.grantReporting!.export(ctx, "samordnet", report, "pdf");
    expect(Buffer.from(pdf!.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });
});
