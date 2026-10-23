// SPDX-License-Identifier: AGPL-3.0-only
// Cell values of an import file (P1.3b): dates in ISO or the country's order,
// genders, guardianship kinds, membership types and yes/no in Swedish,
// English and Norwegian. Unknown values are null (the row gets an issue code).

import type { Gender, GuardianshipKind, MembershipType } from "@clubadmin/shared";

const pad = (n: number) => String(n).padStart(2, "0");

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * `2017-04-02`, `20170402`, `02.04.2017` (the country's order) and
 * `2/4/2017` only when unambiguous (one part above 12, or both the same).
 */
export function parseDate(value: string, order: "dmy" | "mdy"): string | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v) ?? /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(v);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "dmy" ? calendarDate(Number(m[3]), b, a) : calendarDate(Number(m[3]), a, b);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) {
    const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === b) return calendarDate(year, a, b);
    if (a > 12 && b <= 12) return calendarDate(year, b, a);
    if (b > 12 && a <= 12) return calendarDate(year, a, b);
    return null;
  }
  return null;
}

const GENDERS: Record<string, Gender> = {
  kvinna: "female",
  k: "female",
  flicka: "female",
  tjej: "female",
  female: "female",
  f: "female",
  woman: "female",
  girl: "female",
  kvinne: "female",
  jente: "female",
  man: "male",
  m: "male",
  pojke: "male",
  kille: "male",
  male: "male",
  boy: "male",
  mann: "male",
  gutt: "male",
  annat: "other",
  annet: "other",
  other: "other",
  x: "other",
};

export const parseGender = (value: string): Gender | null =>
  GENDERS[value.trim().toLowerCase()] ?? null;

const KINDS: [RegExp, GuardianshipKind][] = [
  [/^(bonus|styv|step|ste)/, "step_parent"],
  [/^(familjehem|foster)/, "foster_parent"],
  [/^(vårdnadshavare|legal guardian|guardian|verge|målsman)$/, "legal_guardian"],
  [/^(förälder|parent|forelder|mamma|pappa|mor|far|mother|father|mamma|pappa)$/, "parent"],
  [/^(kontaktperson|contact|contact person|kontakt)/, "contact_person"],
  [
    /^(släkting|relative|slektning|mormor|morfar|farmor|farfar|grandparent|besteforelder|bestemor|bestefar|moster|faster|morbror|farbror|aunt|uncle|tante|onkel)/,
    "relative",
  ],
];

/** A guardianship kind in any of the languages; empty is a parent. */
export function parseKind(value: string): GuardianshipKind | null {
  const v = value.trim().toLowerCase();
  if (v === "") return "parent";
  return KINDS.find(([pattern]) => pattern.test(v))?.[1] ?? null;
}

const TYPES: [RegExp, MembershipType][] = [
  [/^(aktiv|active|aktiv medlem)$/, "active"],
  [/^(stöd|passiv|supporting|støtte|passive)/, "supporting"],
  [/^(heders|honorary|æres)/, "honorary"],
  [/^(familj|family|familie)/, "family"],
];

export function parseMembershipType(value: string): MembershipType | null {
  const v = value.trim().toLowerCase();
  return TYPES.find(([pattern]) => pattern.test(v))?.[1] ?? null;
}

export const parseYes = (value: string): boolean =>
  /^(ja|j|yes|y|x|1|true|sant|sann)$/i.test(value.trim());

/** "Given Family" split at the last space ("Anna Maria Svensson" → "Anna Maria", "Svensson"). */
export function splitFullName(value: string): [string, string] | null {
  const v = value.trim().replace(/\s+/g, " ");
  // "Svensson, Anna"
  const comma = /^([^,]+),\s*(.+)$/.exec(v);
  if (comma) return [comma[2]!, comma[1]!];
  const at = v.lastIndexOf(" ");
  if (at <= 0) return null;
  return [v.slice(0, at), v.slice(at + 1)];
}

/** Group names separated by `,`, `;` or `|`. */
export const splitList = (value: string): string[] =>
  value
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
