// SPDX-License-Identifier: AGPL-3.0-only
// The Netherlands (fixture): a municipal youth grant (jeugdsubsidie): youth
// members (under 18) living in the municipality on 1 January; the club needs
// at least 20 of them to qualify.

import { definePlugin } from "../../src/index.ts";
import { ageOn, csv, memberOn, texts } from "./util.ts";

export const nlYouth = definePlugin({
  manifest: {
    id: "nl.test.jeugdsubsidie",
    version: "0.1.0",
    publisher: "ClubAdmin tests",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["NL:0363"],
    data: ["birthDate", "homeMunicipality", "membershipStatus"],
    config: [
      {
        key: "municipality",
        type: "text",
        label: "nl.municipality",
        pattern: "\\d{4}",
        required: true,
      },
    ],
    texts: texts({
      "nl.municipality": "Gemeentecode",
      "nl.scheme": "Jeugdsubsidie",
      "nl.youth_members": "Youth members in the municipality",
      "nl.counted": "Counted",
      "nl.elsewhere": "Lives elsewhere",
      "nl.adult": "18 or older",
      "nl.below_minimum": "Fewer than 20 youth members: the club does not qualify",
    }),
  },
  grantReporting: {
    schemes: async () => [
      {
        key: "youth",
        name: "nl.scheme",
        basis: "membership_snapshot",
        required: ["birthDate", "homeMunicipality"],
        formats: ["csv", "json"],
        integration: false,
      },
    ],
    periods: async (_ctx, _scheme, year) => [
      {
        key: String(year),
        from: `${year}-01-01`,
        to: `${year}-01-01`,
        referenceDate: `${year}-01-01`,
        deadline: `${year}-03-31`,
        late: [],
        refusedAfter: `${year}-03-31`,
      },
    ],
    snapshot: async (ctx, _scheme, period, people) => {
      const date = period.referenceDate!;
      const municipality = String(ctx.config.municipality);
      const members = people.filter((p) => memberOn(p, date));
      const rows = members.map((p) => {
        if (!p.birthDate || !p.homeMunicipality) return { personId: p.id, codes: [] as string[] };
        if (ageOn(p.birthDate, date) >= 18) return { personId: p.id, codes: ["nl.adult"] };
        if (p.homeMunicipality !== municipality) return { personId: p.id, codes: ["nl.elsewhere"] };
        return { personId: p.id, codes: ["nl.counted"] };
      });
      const youth = rows.filter((r) => r.codes.includes("nl.counted")).length;
      return {
        referenceDate: date,
        people: rows,
        totals: [
          {
            measure: youth >= 20 ? "nl.youth_members" : "nl.below_minimum",
            dimensions: {},
            value: youth,
          },
        ],
        missing: members.flatMap((p) => [
          ...(p.birthDate ? [] : [{ personId: p.id, field: "birthDate" as const }]),
          ...(p.homeMunicipality ? [] : [{ personId: p.id, field: "homeMunicipality" as const }]),
        ]),
      };
    },
    export: async (_ctx, _scheme, report, format) =>
      format === "json"
        ? [
            {
              name: "jeugdsubsidie.json",
              mediaType: "application/json",
              content: Buffer.from(JSON.stringify(report.snapshot?.totals ?? [])).toString(
                "base64",
              ),
            },
          ]
        : [
            csv(
              "jeugdsubsidie.csv",
              ["measure", "value"],
              (report.snapshot?.totals ?? []).map((t) => [t.measure, t.value]),
            ),
          ],
  },
});
