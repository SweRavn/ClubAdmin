// SPDX-License-Identifier: AGPL-3.0-only
// @clubadmin/country-packs: country-specific rules (ADR 0015). The club's
// `country` selects the pack; the core never branches on country codes.

import { NO } from "./no/index.ts";
import { SE } from "./se/index.ts";
import type { CountryPack } from "./types.ts";

export type {
  AgeRules,
  CountryPack,
  LocaleDefaults,
  MemberImportRules,
  ParsedPersonalId,
  PersonalIdFormat,
} from "./types.ts";
export { NO, SE };

export const COUNTRY_PACKS: Readonly<Record<string, CountryPack>> = { SE, NO };

export const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_PACKS) as readonly string[];

export class UnsupportedCountryError extends Error {
  constructor(code: string) {
    super(`no country pack for "${code}"`);
    this.name = "UnsupportedCountryError";
  }
}

export function getCountryPack(code: string): CountryPack {
  const pack = COUNTRY_PACKS[code.toUpperCase()];
  if (!pack) throw new UnsupportedCountryError(code);
  return pack;
}

export const isSupportedCountry = (code: string): boolean => code.toUpperCase() in COUNTRY_PACKS;

/** Age in whole years on `on` for an ISO birth date (yyyy-mm-dd). */
export function ageOn(birthDate: string, on: Date = new Date()): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const today = { y: on.getUTCFullYear(), m: on.getUTCMonth() + 1, d: on.getUTCDate() };
  let age = today.y - y;
  if (today.m < m || (today.m === m && today.d < d)) age--;
  return age;
}
