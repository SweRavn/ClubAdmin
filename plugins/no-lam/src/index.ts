// SPDX-License-Identifier: AGPL-3.0-only
// Norway's samordnet rapportering as a grant-reporting plugin (P2.7, ADR
// 0051): the club's member and activity figures on 31 December, reported in
// KlubbAdmin by 30 April, from which each municipality's idrettsråd
// distributes lokale aktivitetsmidler (LAM) to clubs with activity for
// children (6–12) and youth (13–19). Sources:
// - NIF, "Lokale aktivitetsmidler (LAM)":
//   https://www.idrettsforbundet.no/klubbguiden/drifte-et-idrettslag/okonomi/stotteordninger/lokale-aktivitetsmidler-lam/
// - NIF's letter for 2026 (figures the councils may use):
//   https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-2026-brev-fra-nif-til-idrettsrad-og-idrettskretser-for-2026.pdf
// - NIF, "Informasjon om LAM for 2026" (members counted from paid memberships):
//   https://www.idrettsforbundet.no/contentassets/57eff2efb62542859be58348aa276fac/lam-informasjon-om-lam-2026-til-idrettsrad-og-idrettskretser.pdf
// - NIF's key figures report 2024 (who counts as active, the age bands):
//   https://www.idrettsforbundet.no/contentassets/9f94ba79767846d9a67d1a56f4054dc2/nokkeltallsrapport-2024---norges-idrettsforbund.pdf
// Members are paying members on 31 December by sex and the age they reach
// that year (0–5, 6–12, 13–19, 20–25, 26+); active members are those who
// take part regularly in a group or hold a role, counted once per sport;
// members with a disability are those in adapted groups (a group flag,
// never health data).

import {
  definePlugin,
  type ExportFile,
  type GrantReport,
  type MissingData,
  type PluginContext,
  type PluginPerson,
  type Snapshot,
  type Total,
} from "@clubadmin/plugin-api";

import { csv, tablePdf } from "./pdf.ts";
import { TEXTS } from "./texts.ts";

const SCHEME = "samordnet";

export const AGE_BANDS = [
  [0, 5],
  [6, 12],
  [13, 19],
  [20, 25],
  [26, Number.POSITIVE_INFINITY],
] as const;

export function bandOf(age: number): string {
  const [lo, hi] = AGE_BANDS.find(([lo, hi]) => age >= lo && age <= hi) ?? AGE_BANDS[0];
  return hi === Number.POSITIVE_INFINITY ? `${lo}+` : `${lo}-${hi}`;
}

/** A member of the club on the date (joined on or before, not left before). */
export function memberOn(p: PluginPerson, date: string): boolean {
  const m = p.membership;
  if (!m) return false;
  if (m.joinedOn && m.joinedOn > date) return false;
  if (m.leftOn && m.leftOn < date) return false;
  return m.status !== "left" || (m.leftOn !== null && m.leftOn >= date);
}

const sexOf = (p: PluginPerson) => (p.sex === "female" || p.sex === "male" ? p.sex : "unspecified");

function count(measure: string, rows: Record<string, string>[]): Total[] {
  const map = new Map<string, { dimensions: Record<string, string>; value: number }>();
  for (const dimensions of rows) {
    const key = JSON.stringify(dimensions);
    const entry = map.get(key) ?? { dimensions, value: 0 };
    entry.value += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => ({ measure, ...e }));
}

export function snapshotOf(
  people: readonly PluginPerson[],
  referenceDate: string,
  options: { allidrettSport?: string | null } = {},
): Snapshot {
  const year = Number(referenceDate.slice(0, 4));
  const members: { p: PluginPerson; age: number }[] = [];
  const rows: { personId: string; codes: string[] }[] = [];
  const missing: MissingData[] = [];
  let total = 0;
  for (const p of [...people].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!memberOn(p, referenceDate)) continue;
    if (p.membershipFeePaid === false) {
      rows.push({ personId: p.id, codes: ["lam.fee_unpaid"] });
      continue;
    }
    total += 1;
    const codes = ["lam.counted"];
    if (p.membershipFeePaid !== true) codes.push("lam.fee_unknown");
    if (!p.birthDate) {
      codes.push("lam.no_birth_date");
      missing.push({ personId: p.id, field: "birthDate" });
    } else {
      members.push({ p, age: year - Number(p.birthDate.slice(0, 4)) });
    }
    if (!p.sex) missing.push({ personId: p.id, field: "sex" });
    const active =
      p.membership?.type === "active" && (p.groups ?? []).some((g) => g.functions.length > 0);
    if (active) codes.push("lam.active_counted");
    rows.push({ personId: p.id, codes });
  }
  const activeRows: Record<string, string>[] = [];
  const disabilityRows: Record<string, string>[] = [];
  const allidrettRows: Record<string, string>[] = [];
  for (const { p, age } of members) {
    const dims = { age: bandOf(age), sex: sexOf(p) };
    if (p.membership?.type === "active") {
      const groups = (p.groups ?? []).filter((g) => g.functions.length > 0);
      for (const sport of new Set(groups.map((g) => g.sport ?? "unspecified"))) {
        activeRows.push({ sport, ...dims });
      }
      for (const sport of new Set(
        groups.filter((g) => g.adapted).map((g) => g.sport ?? "unspecified"),
      )) {
        disabilityRows.push({ sport, ...dims });
      }
    }
    if (
      options.allidrettSport &&
      (p.groups ?? []).some((g) => g.sport === options.allidrettSport)
    ) {
      allidrettRows.push(dims);
    }
  }
  const target = members
    .filter(({ age }) => age >= 6 && age <= 19)
    .map(({ age }) => ({ group: age <= 12 ? "6-12" : "13-19" }));
  return {
    referenceDate,
    people: rows,
    totals: [
      { measure: "lam.members_total", dimensions: {}, value: total },
      ...count(
        "lam.members",
        members.map(({ p, age }) => ({ age: bandOf(age), sex: sexOf(p) })),
      ),
      ...count("lam.target", target),
      ...count("lam.active", activeRows),
      ...count("lam.disability", disabilityRows),
      ...count("lam.allidrett", allidrettRows),
    ],
    missing,
  };
}

async function exportReport(
  ctx: PluginContext,
  report: GrantReport,
  format: string,
): Promise<ExportFile[]> {
  const snapshot = report.snapshot;
  if (!snapshot) return [];
  const texts = TEXTS.nb;
  const header = ["Tall", "Gren", "Alder", "Kjønn", "Antall"];
  const rows = snapshot.totals.map((t) => [
    texts[t.measure] ?? t.measure,
    t.dimensions.sport ?? "",
    t.dimensions.age ?? t.dimensions.group ?? "",
    t.dimensions.sex ?? "",
    t.value,
  ]);
  const base = `samordnet-rapportering-${report.period.key}`;
  if (format === "csv") {
    return [
      {
        name: `${base}.csv`,
        mediaType: "text/csv",
        content: Buffer.from(csv([header, ...rows]), "utf8").toString("base64"),
      },
    ];
  }
  const pdf = await tablePdf({
    title: `${texts["lam.scheme"]!} ${snapshot.referenceDate}`,
    facts: [texts["lam.pdf.source"]!, `${texts["lam.pdf.deadline"]!}: ${report.period.deadline}`],
    header,
    rows,
    createdAt: ctx.now(),
  });
  return [{ name: `${base}.pdf`, mediaType: "application/pdf", content: pdf.toString("base64") }];
}

export const noLam = definePlugin({
  manifest: {
    id: "no.nif.samordnet",
    version: "1.0.0",
    publisher: "ClubAdmin",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["NO"],
    data: [
      "name",
      "birthDate",
      "sex",
      "disability",
      "membershipStatus",
      "membershipFeePaid",
      "groupSport",
      "groupRoles",
    ],
    config: [{ key: "allidrettSport", type: "text", label: "lam.config.allidrett", maxLength: 60 }],
    texts: TEXTS,
  },
  grantReporting: {
    schemes: () =>
      Promise.resolve([
        {
          key: SCHEME,
          name: "lam.scheme",
          basis: "membership_snapshot",
          required: ["birthDate", "sex"],
          formats: ["csv", "pdf"],
          integration: false,
        },
      ]),
    // The figures on 31 December, reported in KlubbAdmin by 30 April.
    periods: (_ctx, _scheme, year) =>
      Promise.resolve([
        {
          key: String(year),
          from: `${year}-01-01`,
          to: `${year}-12-31`,
          referenceDate: `${year}-12-31`,
          deadline: `${year + 1}-04-30`,
          late: [],
          refusedAfter: null,
        },
      ]),
    snapshot: (ctx, _scheme, period, people) =>
      Promise.resolve(
        snapshotOf(people, period.referenceDate ?? period.to, {
          allidrettSport:
            typeof ctx.config.allidrettSport === "string" ? ctx.config.allidrettSport : null,
        }),
      ),
    export: (ctx, _scheme, report, format) => exportReport(ctx, report, format),
  },
});
