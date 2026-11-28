// SPDX-License-Identifier: AGPL-3.0-only
// The rules of background checks (P2.8), apart from the database so they
// are tested on their own: a club's effective requirements (the plugin of
// its country, raised by the club's stricter additions, never lowered), when
// a record stops counting, and whether a person's records cover what their
// roles or a duty need.

import type { CheckType, Requirement } from "@clubadmin/plugin-api";
import {
  type BackgroundCheckCategory,
  type BackgroundCheckClubRequirement,
  CATEGORY_STRICTNESS,
} from "@clubadmin/shared";

/** A plugin's declarations (read once per process; the contract makes them static). */
export interface PluginDeclarations {
  pluginId: string;
  regions: readonly string[];
  types: readonly CheckType[];
  requirements: readonly Requirement[];
}

/** One required check for a category in the club. */
export interface Rule {
  category: BackgroundCheckCategory;
  pluginId: string;
  checkType: string;
  /** Months after the issue date a new check is needed (null: never). */
  recheckMonths: number | null;
}

export interface ClubRules {
  /** The background-check plugin of the club's country (null: none installed). */
  pluginId: string | null;
  /** False: no plugin for the country, or the club turned it off. */
  active: boolean;
  rules: Rule[];
}

/** The plugin serving the country (the first by ID when several would). */
export function pluginForCountry(
  catalogue: readonly PluginDeclarations[],
  country: string,
): PluginDeclarations | null {
  return (
    [...catalogue]
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
      .find((p) => p.regions.includes(country) || p.regions.includes("*")) ?? null
  );
}

/**
 * The club's effective requirements: the plugin's required ones, its
 * recommended ones the club raised to required, and the club's shorter
 * intervals (a longer one never applies).
 */
export function clubRules(
  catalogue: readonly PluginDeclarations[],
  country: string,
  disabledPluginIds: readonly string[],
  club: readonly BackgroundCheckClubRequirement[],
): ClubRules {
  const plugin = pluginForCountry(catalogue, country);
  if (!plugin) return { pluginId: null, active: false, rules: [] };
  if (disabledPluginIds.includes(plugin.pluginId)) {
    return { pluginId: plugin.pluginId, active: false, rules: [] };
  }
  const interval = (checkType: string) =>
    plugin.types.find((t) => t.key === checkType)?.recheckMonths ?? null;
  const rules = new Map<string, Rule>();
  const keyOf = (category: string, checkType: string) => `${category}:${checkType}`;
  for (const r of plugin.requirements) {
    if (r.level !== "required") continue;
    rules.set(keyOf(r.category, r.checkType), {
      category: r.category,
      pluginId: plugin.pluginId,
      checkType: r.checkType,
      recheckMonths: interval(r.checkType),
    });
  }
  for (const c of club) {
    if (c.pluginId !== plugin.pluginId) continue;
    if (!plugin.types.some((t) => t.key === c.checkType)) continue;
    const key = keyOf(c.category, c.checkType);
    const base = rules.get(key)?.recheckMonths ?? interval(c.checkType);
    rules.set(key, {
      category: c.category,
      pluginId: plugin.pluginId,
      checkType: c.checkType,
      recheckMonths: shorter(base, c.recheckMonths),
    });
  }
  return { pluginId: plugin.pluginId, active: true, rules: [...rules.values()] };
}

const shorter = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);

/** Whether the club's addition is stricter than (or equal to) the plugin, never weaker. */
export function weakerThanPlugin(
  plugin: PluginDeclarations,
  addition: BackgroundCheckClubRequirement,
): boolean {
  const type = plugin.types.find((t) => t.key === addition.checkType);
  if (!type) return true;
  return (
    type.recheckMonths !== null &&
    addition.recheckMonths !== null &&
    addition.recheckMonths > type.recheckMonths
  );
}

/** A mapping of a duty type is never weaker than its contact with children's category. */
export function weakerCategory(
  base: BackgroundCheckCategory | null,
  chosen: BackgroundCheckCategory | null,
): boolean {
  if (chosen === null || base === null) return false;
  return CATEGORY_STRICTNESS[chosen] < CATEGORY_STRICTNESS[base];
}

export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** A record as enforcement needs it. */
export interface CheckFact {
  id: string;
  pluginId: string;
  checkType: string;
  issuedOn: string;
  validUntil: string | null;
}

/** The last day a record counts under a rule (null: no end). */
export function expiresOn(record: CheckFact, rule: Rule): string | null {
  const byInterval =
    rule.recheckMonths === null ? null : addMonths(record.issuedOn, rule.recheckMonths);
  if (byInterval === null) return record.validUntil;
  if (record.validUntil === null) return byInterval;
  return byInterval < record.validUntil ? byInterval : record.validUntil;
}

/** The last day the person's records cover a rule (undefined: not covered today). */
export function coveredUntil(
  records: readonly CheckFact[],
  rule: Rule,
  today: string,
): string | null | undefined {
  let best: string | null | undefined;
  for (const r of records) {
    if (r.pluginId !== rule.pluginId || r.checkType !== rule.checkType) continue;
    const end = expiresOn(r, rule);
    if (end !== null && end < today) continue;
    if (end === null) return null;
    if (best === undefined || (best !== null && end > best)) best = end;
  }
  return best;
}

export type Coverage =
  | { status: "not_required" }
  | { status: "missing"; missing: Rule[] }
  | { status: "valid"; expiresOn: string | null };

/** Whether the records cover every rule of the given categories today. */
export function coverage(
  rules: ClubRules,
  categories: readonly BackgroundCheckCategory[],
  records: readonly CheckFact[],
  today: string,
): Coverage {
  if (!rules.active) return { status: "not_required" };
  const needed = rules.rules.filter((r) => categories.includes(r.category));
  if (needed.length === 0) return { status: "not_required" };
  const missing: Rule[] = [];
  let earliest: string | null = null;
  for (const rule of needed) {
    const until = coveredUntil(records, rule, today);
    if (until === undefined) missing.push(rule);
    else if (until !== null && (earliest === null || until < earliest)) earliest = until;
  }
  return missing.length ? { status: "missing", missing } : { status: "valid", expiresOn: earliest };
}

/** The status of a person in the overview: missing, expiring (within `days`), valid. */
export function overviewStatus(
  c: Coverage,
  hasRecords: boolean,
  today: string,
  days: number,
): "missing" | "expiring" | "valid" | "to_delete" | null {
  if (c.status === "not_required") return hasRecords ? "to_delete" : null;
  if (c.status === "missing") return "missing";
  if (c.expiresOn !== null && c.expiresOn <= addDays(today, days)) return "expiring";
  return "valid";
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
