// SPDX-License-Identifier: AGPL-3.0-only
// Finland (fixture): municipal activity grant: participants under 20 per
// group and the number of led sessions (a leader present, at least 60
// minutes); sessions count per group and year.

import { definePlugin, type PluginPerson, type PluginSession } from "../../src/index.ts";
import { ageInYear, csv, texts } from "./util.ts";

export const fiActive = definePlugin({
  manifest: {
    id: "fi.test.toiminta-avustus",
    version: "0.1.0",
    publisher: "ClubAdmin tests",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["FI"],
    data: ["birthDate", "attendance", "leaders"],
    texts: texts({
      "fi.scheme": "Toiminta-avustus",
      "fi.led_sessions": "Led sessions",
      "fi.active_under_20": "Active participants under 20",
      "fi.too_short": "Under 60 minutes",
      "fi.no_leader": "No leader",
      "fi.no_young": "Nobody under 20",
    }),
  },
  grantReporting: {
    schemes: async () => [
      {
        key: "activity",
        name: "fi.scheme",
        basis: "session",
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
        referenceDate: null,
        deadline: `${year + 1}-02-28`,
        late: [{ until: `${year + 1}-03-31`, percent: 10 }],
        refusedAfter: `${year + 1}-03-31`,
      },
    ],
    evaluateSession: async (_ctx, _scheme, session, people) => evaluate(session, people),
    evaluatePeriod: async (_ctx, _scheme, _period, sessions, people) => {
      const evaluations = sessions.map((s) => evaluate(s, people));
      const active = new Map<string, number>();
      for (const e of evaluations)
        for (const id of e.countedPersonIds) active.set(id, (active.get(id) ?? 0) + 1);
      const byGroup = new Map<string, number>();
      for (const [i, e] of evaluations.entries()) {
        if (e.counts)
          byGroup.set(sessions[i]!.groupId, (byGroup.get(sessions[i]!.groupId) ?? 0) + 1);
      }
      return {
        sessions: evaluations,
        people: [...active]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([personId, counted]) => ({ personId, counted, codes: [] })),
        totals: [
          ...[...byGroup].sort().map(([group, value]) => ({
            measure: "fi.led_sessions",
            dimensions: { group },
            value,
          })),
          { measure: "fi.active_under_20", dimensions: {}, value: active.size },
        ],
        missing: people
          .filter((p) => !p.birthDate)
          .map((p) => ({ personId: p.id, field: "birthDate" as const })),
      };
    },
    export: async (_ctx, _scheme, report) => [
      csv(
        "toiminta.csv",
        ["measure", "group", "value"],
        (report.evaluation?.totals ?? []).map((t) => [
          t.measure,
          t.dimensions.group ?? "",
          t.value,
        ]),
      ),
    ],
  },
});

function evaluate(session: PluginSession, people: PluginPerson[]) {
  const year = Number(session.date.slice(0, 4));
  const born = new Map(people.map((p) => [p.id, p.birthDate ?? null]));
  const young = (session.participantIds ?? []).filter((id) => {
    const b = born.get(id);
    return b ? ageInYear(b, year) < 20 : false;
  });
  const codes: string[] = [];
  if (session.durationMinutes < 60) codes.push("fi.too_short");
  if (!session.leaderIds?.length) codes.push("fi.no_leader");
  if (young.length === 0) codes.push("fi.no_young");
  const counts = codes.length === 0;
  return { sessionId: session.id, counts, codes, countedPersonIds: counts ? young.sort() : [] };
}
