// SPDX-License-Identifier: AGPL-3.0-only
// Germany (fixture): the Bestandserhebung (A-numbers: members per age band
// and sex; B-numbers: per sport) on 1 January, and the
// Übungsleiterzuschuss (a leader-based scheme: licensed leaders' sessions
// of at least 45 minutes in the half year).

import { definePlugin } from "../../src/index.ts";
import { ageOn, count, csv, memberOn, texts } from "./util.ts";

const BANDS = [
  [0, 6],
  [7, 14],
  [15, 18],
  [19, 26],
  [27, 40],
  [41, 60],
  [61, 200],
] as const;
const band = (age: number) => {
  const b = BANDS.find(([lo, hi]) => age >= lo && age <= hi)!;
  return `${b[0]}-${b[1]}`;
};

export const deSport = definePlugin({
  manifest: {
    id: "de.test.lsb",
    version: "0.1.0",
    publisher: "ClubAdmin tests",
    licence: "MIT",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["DE", "DE-BY"],
    data: [
      "birthDate",
      "sex",
      "membershipStatus",
      "groupSport",
      "attendance",
      "leaders",
      "groupRoles",
    ],
    config: [
      { key: "lsb", type: "choice", label: "de.lsb", options: ["blsv", "lsbnrw"], required: true },
    ],
    texts: texts({
      "de.lsb": "Landessportbund",
      "de.lsb.blsv": "BLSV",
      "de.lsb.lsbnrw": "LSB NRW",
      "de.bestand": "Bestandserhebung",
      "de.a_numbers": "A-Zahlen",
      "de.b_numbers": "B-Zahlen",
      "de.counted": "Counted",
      "de.uebungsleiter": "Übungsleiterzuschuss",
      "de.leader_sessions": "Sessions led",
      "de.too_short": "Under 45 minutes",
      "de.no_leader": "No leader present",
    }),
  },
  grantReporting: {
    schemes: async () => [
      {
        key: "bestand",
        name: "de.bestand",
        basis: "membership_snapshot",
        required: ["birthDate", "sex"],
        formats: ["csv"],
        integration: false,
      },
      {
        key: "uebungsleiter",
        name: "de.uebungsleiter",
        basis: "leader",
        required: [],
        formats: ["csv"],
        integration: false,
      },
    ],
    periods: async (_ctx, scheme, year) =>
      scheme === "bestand"
        ? [
            {
              key: String(year),
              from: `${year}-01-01`,
              to: `${year}-01-01`,
              referenceDate: `${year}-01-01`,
              deadline: `${year}-01-31`,
              late: [],
              refusedAfter: null,
            },
          ]
        : [
            {
              key: `${year}-1`,
              from: `${year}-01-01`,
              to: `${year}-06-30`,
              referenceDate: null,
              deadline: `${year}-07-31`,
              late: [],
              refusedAfter: null,
            },
            {
              key: `${year}-2`,
              from: `${year}-07-01`,
              to: `${year}-12-31`,
              referenceDate: null,
              deadline: `${year + 1}-01-31`,
              late: [],
              refusedAfter: null,
            },
          ],
    snapshot: async (_ctx, _scheme, period, people) => {
      const date = period.referenceDate!;
      const members = people.filter((p) => memberOn(p, date));
      const known = members.filter((p) => p.birthDate && p.sex);
      return {
        referenceDate: date,
        people: known.map((p) => ({ personId: p.id, codes: ["de.counted"] })),
        totals: [
          ...count(
            "de.a_numbers",
            known.map((p) => ({ age: band(ageOn(p.birthDate!, date)), sex: p.sex! })),
          ),
          ...count(
            "de.b_numbers",
            known.flatMap((p) =>
              [...new Set((p.groups ?? []).map((g) => g.sport ?? "none"))].map((sport) => ({
                sport,
              })),
            ),
          ),
        ],
        missing: members.flatMap((p) => [
          ...(p.birthDate ? [] : [{ personId: p.id, field: "birthDate" as const }]),
          ...(p.sex ? [] : [{ personId: p.id, field: "sex" as const }]),
        ]),
      };
    },
    evaluatePeriod: async (_ctx, _scheme, _period, sessions) => {
      const perLeader = new Map<string, number>();
      const evaluations = sessions.map((s) => {
        const codes: string[] = [];
        if (s.durationMinutes < 45) codes.push("de.too_short");
        if (!s.leaderIds?.length) codes.push("de.no_leader");
        const counts = codes.length === 0;
        if (counts) for (const l of s.leaderIds!) perLeader.set(l, (perLeader.get(l) ?? 0) + 1);
        return {
          sessionId: s.id,
          counts,
          codes,
          countedPersonIds: counts ? [...s.leaderIds!] : [],
        };
      });
      const people = [...perLeader]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([personId, counted]) => ({ personId, counted, codes: [] }));
      return {
        sessions: evaluations,
        people,
        totals: [
          {
            measure: "de.leader_sessions",
            dimensions: {},
            value: people.reduce((n, p) => n + p.counted, 0),
          },
        ],
        missing: [],
      };
    },
    export: async (_ctx, scheme, report) =>
      scheme === "bestand"
        ? [
            csv(
              "bestand.csv",
              ["measure", "dimensions", "value"],
              (report.snapshot?.totals ?? []).map((t) => [
                t.measure,
                JSON.stringify(t.dimensions),
                t.value,
              ]),
            ),
          ]
        : [
            csv(
              "uebungsleiter.csv",
              ["leader", "sessions"],
              (report.evaluation?.people ?? []).map((p) => [p.personId, p.counted]),
            ),
          ],
  },
});
