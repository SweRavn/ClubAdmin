// SPDX-License-Identifier: AGPL-3.0-only
// Sweden's LOK-stöd (statligt lokalt aktivitetsstöd) as a grant-reporting
// plugin (P2.7, ADR 0051). The rules are RF's of 22 May 2025, versioned by
// the activity's date (rules.ts); the report shows per session and person
// what counts and why, the totals in multiples of RF's yearly amounts (X, Y
// and Z are set by RS each year, so no kronor), and what data is missing.
// Reporting itself happens in idrottens verksamhetsredovisningssystem: the
// files are for checking and registering; the RF integration needs an
// agreement (issue #22) and is not part of the plugin yet.

import {
  definePlugin,
  type ExportFile,
  type GrantReport,
  type PluginContext,
} from "@clubadmin/plugin-api";

import { evaluatePeriodSessions, evaluateSessionAlone, type LokOptions } from "./evaluate.ts";
import { csv, tablePdf } from "./pdf.ts";
import { periodsOf } from "./rules.ts";
import { TEXTS } from "./texts.ts";

export { evaluatePeriodSessions, evaluateSessionAlone } from "./evaluate.ts";
export {
  ageInYear,
  isoWeek,
  type LokRules,
  RULE_VERSIONS,
  RULES_2025_07_01,
  rulesFor,
} from "./rules.ts";

const SCHEME = "lok";

const optionsOf = (ctx: PluginContext): LokOptions =>
  typeof ctx.config.minMinutes === "number" ? { minMinutes: ctx.config.minMinutes } : {};

const nameOf = (report: GrantReport, id: string) => {
  const p = report.people.find((x) => x.id === id);
  return p ? `${p.givenName ?? ""} ${p.familyName ?? ""}`.trim() : id;
};

async function exportReport(
  ctx: PluginContext,
  report: GrantReport,
  format: string,
): Promise<ExportFile[]> {
  const evaluation = report.evaluation;
  if (!evaluation) return [];
  const texts = TEXTS.sv;
  const sessions = new Map(report.sessions.map((s) => [s.id, s]));
  const header = ["Datum", "Idrott", "Minuter", "Räknas", "Skäl", "Person", "Född"];
  const rows: (string | number)[][] = [];
  for (const e of evaluation.sessions) {
    const s = sessions.get(e.sessionId);
    if (!s) continue;
    const reasons = e.codes.map((c) => texts[c] ?? c).join(", ");
    const counted = e.countedPersonIds.length ? e.countedPersonIds : [""];
    for (const id of counted) {
      const born = report.people.find((p) => p.id === id)?.birthDate ?? "";
      rows.push([
        s.date,
        s.sport ?? "",
        s.durationMinutes,
        e.counts ? "ja" : "nej",
        reasons,
        id ? nameOf(report, id) : "",
        born,
      ]);
    }
  }
  const base = `lok-${report.period.key}`;
  if (format === "csv") {
    return [
      {
        name: `${base}.csv`,
        mediaType: "text/csv",
        content: Buffer.from(csv([header, ...rows]), "utf8").toString("base64"),
      },
    ];
  }
  const totals = evaluation.totals.map(
    (t) =>
      `${texts[t.measure] ?? t.measure}${t.dimensions.age ? ` (${t.dimensions.age})` : ""}: ${t.value}`,
  );
  const pdf = await tablePdf({
    title: `LOK-stöd ${report.period.from} – ${report.period.to}`,
    facts: [
      texts["lok.pdf.rules"]!,
      ...totals,
      `${texts["lok.pdf.deadline"]!}: ${report.period.deadline}`,
    ],
    header,
    rows,
    createdAt: ctx.now(),
  });
  return [{ name: `${base}.pdf`, mediaType: "application/pdf", content: pdf.toString("base64") }];
}

export const seLok = definePlugin({
  manifest: {
    id: "se.rf.lok",
    version: "1.0.0",
    publisher: "ClubAdmin",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["SE"],
    data: [
      "name",
      "birthDate",
      "sex",
      "personalIdentityNumber",
      "disability",
      "membershipStatus",
      "groupSport",
      "attendance",
      "leaders",
    ],
    config: [
      // A municipal variant asking for longer group activities (e.g. 60 minutes).
      { key: "minMinutes", type: "number", label: "lok.config.minMinutes" },
    ],
    texts: TEXTS,
  },
  grantReporting: {
    schemes: () =>
      Promise.resolve([
        {
          key: SCHEME,
          name: "lok.scheme",
          basis: "session",
          required: ["birthDate", "personalIdentityNumber", "sex"],
          formats: ["csv", "pdf"],
          integration: false,
        },
      ]),
    periods: (_ctx, _scheme, year) => Promise.resolve(periodsOf(year)),
    evaluateSession: (ctx, _scheme, session, people) =>
      Promise.resolve(evaluateSessionAlone(session, people, optionsOf(ctx))),
    evaluatePeriod: (ctx, _scheme, _period, sessions, people) =>
      Promise.resolve(evaluatePeriodSessions(sessions, people, optionsOf(ctx))),
    export: (ctx, _scheme, report, format) => exportReport(ctx, report, format),
  },
});
