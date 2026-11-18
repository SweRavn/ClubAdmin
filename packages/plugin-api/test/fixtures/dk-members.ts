// SPDX-License-Identifier: AGPL-3.0-only
// Denmark (fixture): medlemstilskud, members under 25 on a reference date
// (31 December) who have paid the fee, counted by age band (CFR-style).

import { definePlugin, type PluginPerson } from "../../src/index.ts";
import { ageOn, count, csv, memberOn, texts } from "./util.ts";

export const dkMembers = definePlugin({
  manifest: {
    id: "dk.test.medlemstilskud",
    version: "0.1.0",
    publisher: "ClubAdmin tests",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["DK"],
    data: ["birthDate", "membershipStatus", "membershipFeePaid"],
    texts: texts({
      "dk.scheme": "Medlemstilskud",
      "dk.members_under_25": "Members under 25",
      "dk.counted": "Counted",
      "dk.over_25": "25 or older",
      "dk.fee_unpaid": "Fee not paid",
    }),
  },
  grantReporting: {
    schemes: async () => [
      {
        key: "members",
        name: "dk.scheme",
        basis: "membership_snapshot",
        required: ["birthDate"],
        formats: ["csv"],
        integration: false,
      },
    ],
    periods: async (_ctx, _scheme, year) => [
      {
        key: String(year),
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        referenceDate: `${year}-12-31`,
        deadline: `${year + 1}-04-30`,
        late: [],
        refusedAfter: `${year + 1}-04-30`,
      },
    ],
    snapshot: async (_ctx, _scheme, period, people) => {
      const date = period.referenceDate!;
      const counted: { p: PluginPerson; band: string }[] = [];
      const result = people
        .filter((p) => memberOn(p, date))
        .map((p) => {
          if (!p.birthDate) return { personId: p.id, codes: [] as string[] };
          const age = ageOn(p.birthDate, date);
          if (age >= 25) return { personId: p.id, codes: ["dk.over_25"] };
          if (p.membershipFeePaid === false) return { personId: p.id, codes: ["dk.fee_unpaid"] };
          counted.push({ p, band: age < 13 ? "0-12" : "13-24" });
          return { personId: p.id, codes: ["dk.counted"] };
        });
      return {
        referenceDate: date,
        people: result,
        totals: count(
          "dk.members_under_25",
          counted.map((c) => ({ age: c.band })),
        ),
        missing: people
          .filter((p) => memberOn(p, date) && !p.birthDate)
          .map((p) => ({ personId: p.id, field: "birthDate" as const })),
      };
    },
    export: async (_ctx, _scheme, report) => [
      csv(
        "medlemstilskud.csv",
        ["age", "count"],
        (report.snapshot?.totals ?? []).map((t) => [t.dimensions.age ?? "", t.value]),
      ),
    ],
  },
});
