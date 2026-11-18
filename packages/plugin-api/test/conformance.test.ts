// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/require-await -- fake remotes and plugins answer at once */
// Every fixture plugin passes the conformance suite, and a misbehaving one
// is caught on every rule (P2.7 tests, item 1).

import { describe, expect, it } from "vitest";

import { checkConformance } from "../src/testing/index.ts";
import { deCheck, esCheck, frCheck, ieCheck, noCheck, seCheck } from "./fixtures/checks.ts";
import { deSport } from "./fixtures/de-sport.ts";
import { dkMembers } from "./fixtures/dk-members.ts";
import { fiActive } from "./fixtures/fi-active.ts";
import { misbehaving, slow } from "./fixtures/misbehaving.ts";
import { nlYouth } from "./fixtures/nl-youth.ts";
import { club } from "./samples.ts";

const sample = club();
const grants = { year: 2026, sessions: sample.sessions, people: sample.people };
const someone = sample.people[0]!.id;

describe("conformance", () => {
  it.each([
    ["DK", dkMembers, {}],
    ["DE", deSport, { config: { lsb: "blsv" } }],
    ["NL", nlYouth, { config: { municipality: "0363" } }],
    ["FI", fiActive, {}],
  ] as const)("the %s grant fixture conforms", async (_c, plugin, extra) => {
    expect(await checkConformance(plugin, { grants, ...extra })).toEqual([]);
  });

  it("the background-check fixtures conform", async () => {
    const http = async (url: string) =>
      url.includes("polisen")
        ? { status: 200, headers: {}, body: '{"clean":true}' }
        : url.includes("federation")
          ? { status: 200, headers: {}, body: "[]" }
          : { status: 200, headers: {}, body: '{"entries":false}' };
    const presented = [
      { personId: someone, checkType: "", issuedOn: "2026-10-01", code: "ABC123" },
    ];
    const with_ = (checkType: string) => presented.map((p) => ({ ...p, checkType }));
    expect(
      await checkConformance(seCheck, { http, checks: { presented: with_("extract") } }),
    ).toEqual([]);
    expect(await checkConformance(deCheck, { checks: { presented: with_("efz") } })).toEqual([]);
    expect(
      await checkConformance(esCheck, { http, checks: { presented: with_("certificado") } }),
    ).toEqual([]);
    expect(
      await checkConformance(noCheck, {
        checks: { requests: [{ personId: someone, checkType: "attest" }] },
      }),
    ).toEqual([]);
    expect(
      await checkConformance(ieCheck, {
        checks: { requests: [{ personId: someone, checkType: "vetting" }] },
      }),
    ).toEqual([]);
    expect(
      await checkConformance(frCheck, {
        http,
        checks: { feed: { since: "2026-09-01", people: [{ id: someone }] } },
      }),
    ).toEqual([]);
  });

  it("catches every broken rule", async () => {
    const problems = await checkConformance(misbehaving, { grants });
    expect(problems).toEqual(
      expect.arrayContaining([
        "bad.evaluatePeriod: not deterministic",
        "text bad.undocumented is missing",
        "reads undeclared data: birthDate",
        "reads undeclared data: givenName",
        "calls an undeclared host: evil.example",
        "logs personal data or free text in person",
        "bad.export.csv: plugin_invalid_output (Too small: expected array to have >=1 items)",
      ]),
    );
  });

  it("reports a plugin that never answers", async () => {
    expect(await checkConformance(slow, { grants, timeoutMs: 30 })).toEqual([
      "schemes: plugin_timeout (over 30 ms)",
    ]);
  });
});
