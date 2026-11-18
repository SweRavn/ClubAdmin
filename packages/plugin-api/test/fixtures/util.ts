// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the fixture plugins (test tree only; not shipped).

import type { ExportFile, PluginPerson, Total } from "../../src/index.ts";

/** Whole years on a date. */
export function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The age a person turns in a calendar year. */
export function ageInYear(birthDate: string, year: number): number {
  return year - Number(birthDate.slice(0, 4));
}

/** Members of the club on a date (active or paused, joined on or before, not left before). */
export function memberOn(p: PluginPerson, date: string): boolean {
  const m = p.membership;
  if (!m) return false;
  if (m.joinedOn && m.joinedOn > date) return false;
  if (m.leftOn && m.leftOn < date) return false;
  return m.status !== "left" || (m.leftOn !== null && m.leftOn >= date);
}

export function csv(name: string, header: string[], rows: (string | number)[][]): ExportFile {
  const text = [header, ...rows].map((r) => r.join(";")).join("\n") + "\n";
  return { name, mediaType: "text/csv", content: Buffer.from(text, "utf8").toString("base64") };
}

/** Totals grouped by dimension values. */
export function count(measure: string, items: Record<string, string>[]): Total[] {
  const map = new Map<string, { dimensions: Record<string, string>; value: number }>();
  for (const dims of items) {
    const key = JSON.stringify(dims);
    const entry = map.get(key) ?? { dimensions: dims, value: 0 };
    entry.value += 1;
    map.set(key, entry);
  }
  return [...map.values()]
    .sort((a, b) => JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)))
    .map((e) => ({ measure, ...e }));
}

/** The same texts in sv, en and nb (fixtures are not translated). */
export function texts(entries: Record<string, string>) {
  return { sv: entries, en: entries, nb: entries };
}
