// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/require-await -- fake remotes and plugins answer at once */
// The contract can express other countries' schemes (P2.7 tests, items 4
// and 5): exact expectations for each fixture plugin.

import { describe, expect, it } from "vitest";

import { minimizePerson, type Period, type PluginPerson } from "../src/index.ts";
import { testContext } from "../src/testing/index.ts";
import { deCheck, esCheck, frCheck, ieCheck, noCheck, seCheck } from "./fixtures/checks.ts";
import { deSport } from "./fixtures/de-sport.ts";
import { dkMembers } from "./fixtures/dk-members.ts";
import { fiActive } from "./fixtures/fi-active.ts";
import { nlYouth } from "./fixtures/nl-youth.ts";
import { GROUP, person, session, uuid } from "./samples.ts";

const ctx = testContext();
const periodOf = async (plugin: typeof dkMembers, scheme: string, year = 2026): Promise<Period> =>
  (await plugin.grantReporting!.periods(ctx, scheme, year))[0]!;
const codesById = (rows: { personId: string; codes: string[] }[]) =>
  Object.fromEntries(rows.map((r) => [r.personId, r.codes]));

describe("Denmark: members under 25 on 31 December with the fee paid", () => {
  it("counts by age on the reference date, fee and membership period", async () => {
    const young = person({ birthDate: "2002-01-01" }); // 24 on 31 Dec 2026
    const turns25 = person({ birthDate: "2001-12-31" }); // 25 on the day
    const unpaid = person({ birthDate: "2010-01-01", membershipFeePaid: false });
    const joinedLate = person({
      membership: { status: "active", type: "active", joinedOn: "2027-01-02", leftOn: null },
    });
    const leftEarly = person({
      membership: { status: "left", type: "active", joinedOn: "2020-01-01", leftOn: "2026-06-30" },
    });
    const unknown = person({ birthDate: null });
    const people = [young, turns25, unpaid, joinedLate, leftEarly, unknown].map((p) =>
      minimizePerson(p, dkMembers.manifest.data),
    );
    const snapshot = await dkMembers.grantReporting!.snapshot!(
      ctx,
      "members",
      await periodOf(dkMembers, "members"),
      people,
    );
    expect(codesById(snapshot.people)).toEqual({
      [young.id]: ["dk.counted"],
      [turns25.id]: ["dk.over_25"],
      [unpaid.id]: ["dk.fee_unpaid"],
      [unknown.id]: [],
    });
    expect(snapshot.totals).toEqual([
      { measure: "dk.members_under_25", dimensions: { age: "13-24" }, value: 1 },
    ]);
    expect(snapshot.missing).toEqual([{ personId: unknown.id, field: "birthDate" }]);
  });
});

describe("Germany: Bestandserhebung and Übungsleiterzuschuss", () => {
  it("counts A-numbers by age band and sex and B-numbers by sport on 1 January", async () => {
    const people = [
      person({ birthDate: "2015-06-01", sex: "female" }), // 10
      person({ birthDate: "2014-06-01", sex: "female" }), // 11
      person({
        birthDate: "1990-01-01",
        sex: "male",
        groups: [{ groupId: GROUP, functions: ["member"], sport: "handball" }],
      }),
      person({ sex: null }),
    ].map((p) => minimizePerson(p, deSport.manifest.data));
    const period = await periodOf(deSport, "bestand");
    const snapshot = await deSport.grantReporting!.snapshot!(
      testContext({ config: { lsb: "blsv" } }),
      "bestand",
      period,
      people,
    );
    expect(snapshot.totals).toEqual([
      { measure: "de.a_numbers", dimensions: { age: "27-40", sex: "male" }, value: 1 },
      { measure: "de.a_numbers", dimensions: { age: "7-14", sex: "female" }, value: 2 },
      { measure: "de.b_numbers", dimensions: { sport: "football" }, value: 2 },
      { measure: "de.b_numbers", dimensions: { sport: "handball" }, value: 1 },
    ]);
    expect(snapshot.missing).toEqual([{ personId: people[3]!.id, field: "sex" }]);
  });

  it("counts a leader's sessions of 45 minutes or more", async () => {
    const leader = uuid(1);
    const sessions = [
      session({ durationMinutes: 45, leaderIds: [leader] }),
      session({ durationMinutes: 44, leaderIds: [leader] }),
      session({ durationMinutes: 90, leaderIds: [] }),
    ];
    const [half] = await deSport.grantReporting!.periods(ctx, "uebungsleiter", 2026);
    const evaluation = await deSport.grantReporting!.evaluatePeriod!(
      ctx,
      "uebungsleiter",
      half!,
      sessions,
      [],
    );
    expect(evaluation.sessions.map((s) => [s.counts, s.codes])).toEqual([
      [true, []],
      [false, ["de.too_short"]],
      [false, ["de.no_leader"]],
    ]);
    expect(evaluation.people).toEqual([{ personId: leader, counted: 1, codes: [] }]);
  });
});

describe("The Netherlands: youth members in the municipality, at least 20", () => {
  const youth = (n: number, municipality = "0363"): PluginPerson[] =>
    Array.from({ length: n }, () =>
      minimizePerson(
        person({ birthDate: "2012-01-01", homeMunicipality: municipality }),
        nlYouth.manifest.data,
      ),
    );
  const config = testContext({ config: { municipality: "0363" } });

  it("qualifies with 20 youth members living in the municipality", async () => {
    const period = await periodOf(nlYouth, "youth");
    const snapshot = await nlYouth.grantReporting!.snapshot!(config, "youth", period, [
      ...youth(20),
      ...youth(3, "0599"),
    ]);
    expect(snapshot.totals).toEqual([{ measure: "nl.youth_members", dimensions: {}, value: 20 }]);
    expect(snapshot.people.filter((p) => p.codes[0] === "nl.elsewhere")).toHaveLength(3);
  });

  it("does not qualify with 19", async () => {
    const period = await periodOf(nlYouth, "youth");
    const snapshot = await nlYouth.grantReporting!.snapshot!(config, "youth", period, youth(19));
    expect(snapshot.totals).toEqual([{ measure: "nl.below_minimum", dimensions: {}, value: 19 }]);
  });
});

describe("Finland: led sessions per group and active participants under 20", () => {
  it("counts sessions of 60 minutes with a leader and someone under 20", async () => {
    const young = person({ birthDate: "2007-03-01" }); // turns 19 in 2026
    const old = person({ birthDate: "2006-03-01" }); // turns 20
    const leader = person({ birthDate: "1980-01-01" });
    const people = [young, old, leader].map((p) => minimizePerson(p, fiActive.manifest.data));
    const sessions = [
      session({ participantIds: [young.id, old.id], leaderIds: [leader.id] }),
      session({ participantIds: [old.id], leaderIds: [leader.id] }),
      session({ durationMinutes: 59, participantIds: [young.id], leaderIds: [leader.id] }),
    ];
    const period = await periodOf(fiActive, "activity");
    const evaluation = await fiActive.grantReporting!.evaluatePeriod!(
      ctx,
      "activity",
      period,
      sessions,
      people,
    );
    expect(evaluation.sessions.map((s) => s.codes)).toEqual([
      [],
      ["fi.no_young"],
      ["fi.too_short"],
    ]);
    expect(evaluation.totals).toEqual([
      { measure: "fi.led_sessions", dimensions: { group: GROUP }, value: 1 },
      { measure: "fi.active_under_20", dimensions: {}, value: 1 },
    ]);
  });
});

describe("background checks", () => {
  const id = uuid(3);
  const now = new Date("2026-11-18T12:00:00Z");

  it("Sweden: at most six months old, the code checked during the call and never returned", async () => {
    const calls: string[] = [];
    const sctx = testContext({
      now,
      network: seCheck.manifest.network,
      http: async (_url, init) => {
        calls.push(String(init.body));
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ clean: !String(init.body).includes("BAD") }),
        };
      },
    });
    const verify = seCheck.backgroundChecks!.verifyPresented!;
    const ok = await verify(sctx, {
      personId: id,
      checkType: "extract",
      issuedOn: "2026-05-20",
      code: "K-123",
    });
    expect(ok).toEqual({
      outcome: "verified",
      result: {
        checkType: "extract",
        issuingCountry: "SE",
        issuedOn: "2026-05-20",
        method: "code_lookup",
        validUntil: null,
      },
    });
    expect(JSON.stringify(ok)).not.toContain("K-123");
    await expect(
      verify(sctx, { personId: id, checkType: "extract", issuedOn: "2026-05-18" }),
    ).resolves.toEqual({ outcome: "not_verified", reason: "se.too_old" });
    // Something on the extract: closed, without a reason.
    await expect(
      verify(sctx, { personId: id, checkType: "extract", issuedOn: "2026-10-01", code: "BAD" }),
    ).resolves.toEqual({ outcome: "closed" });
    expect(calls).toHaveLength(2);
  });

  it("Norway: the club requests with consent, from 15 years, step by step", async () => {
    const nctx = testContext({ now });
    const [type] = await noCheck.backgroundChecks!.checkTypes(nctx);
    expect(type).toMatchObject({ initiator: "club", minAge: 15 });
    const started = await noCheck.backgroundChecks!.startRequest!(nctx, {
      personId: id,
      checkType: "attest",
    });
    expect(started.status).toBe("consent_pending");
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await noCheck.backgroundChecks!.requestStatus!(nctx, started.reference)).status,
      );
    expect(statuses).toEqual(["submitted", "result_available", "verified"]);
  });

  it("Germany: three months old, again after five years", async () => {
    const dctx = testContext({ now });
    const verify = deCheck.backgroundChecks!.verifyPresented!;
    await expect(
      verify(dctx, { personId: id, checkType: "efz", issuedOn: "2026-09-01" }),
    ).resolves.toMatchObject({ outcome: "verified", result: { validUntil: "2031-11-18" } });
    await expect(
      verify(dctx, { personId: id, checkType: "efz", issuedOn: "2026-08-01" }),
    ).resolves.toEqual({ outcome: "not_verified", reason: "de.too_old" });
  });

  it("France: the federation's feed, valid for a season", async () => {
    const fctx = testContext({
      now,
      network: frCheck.manifest.network,
      http: async () => ({ status: 200, headers: {}, body: JSON.stringify([{ licence: "L1" }]) }),
    });
    const entries = await frCheck.backgroundChecks!.feed!(fctx, "2026-09-01", [
      { id, personalIdentityNumber: "L1" },
      { id: uuid(3), personalIdentityNumber: "L2" },
    ]);
    expect(entries).toEqual([
      {
        personId: id,
        result: {
          checkType: "honorabilite",
          issuingCountry: "FR",
          issuedOn: "2026-09-01",
          method: "federation_feed",
          validUntil: "2027-09-01",
        },
      },
    ]);
  });

  it("Ireland: the organisation receives the result", async () => {
    const ictx = testContext({ now });
    const started = await ieCheck.backgroundChecks!.startRequest!(ictx, {
      personId: id,
      checkType: "vetting",
    });
    await expect(
      ieCheck.backgroundChecks!.requestStatus!(ictx, started.reference),
    ).resolves.toMatchObject({
      status: "verified",
      result: { method: "received_by_club", validUntil: "2029-11-18" },
    });
  });

  it("Spain: the certificate's code is looked up", async () => {
    const ectx = testContext({
      now,
      network: esCheck.manifest.network,
      http: async (url) =>
        url.endsWith("/NOPE")
          ? { status: 404, headers: {}, body: "" }
          : { status: 200, headers: {}, body: '{"entries":false}' },
    });
    const verify = esCheck.backgroundChecks!.verifyPresented!;
    await expect(
      verify(ectx, { personId: id, checkType: "certificado", issuedOn: "2026-01-01", code: "OK" }),
    ).resolves.toMatchObject({ outcome: "verified" });
    await expect(
      verify(ectx, {
        personId: id,
        checkType: "certificado",
        issuedOn: "2026-01-01",
        code: "NOPE",
      }),
    ).resolves.toEqual({ outcome: "not_verified", reason: "es.code_rejected" });
  });
});
