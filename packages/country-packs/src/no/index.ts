// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type CountryPack, easterSunday, isoDate, personalIdFormat } from "../types.ts";
import { parseFodselsnummer } from "./fodselsnummer.ts";
import { normalizeOrganisasjonsnummer } from "./organisasjonsnummer.ts";

export const NO: CountryPack = {
  code: "NO",
  // GDPR consent age in Norway is 13 (personopplysningsloven § 5).
  ageRules: { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 },
  normalizeOrganizationNumber: normalizeOrganisasjonsnummer,
  personalIdFormat: personalIdFormat(parseFodselsnummer),
  localeDefaults: { locale: "nb-NO", timeZone: "Europe/Oslo", currency: "NOK" },
  // Offentlige høytidsdager (helligdagsloven) and 1 and 17 May.
  // Norway's activity grants (lokale aktivitetsmidler) are shared out by
  // the municipality's sports council, not per session: no per-session rules.
  grantRules: null,
  publicHolidays(year) {
    const easter = easterSunday(year);
    return [
      isoDate(year, 1, 1),
      addDays(easter, -3),
      addDays(easter, -2),
      addDays(easter, 0),
      addDays(easter, 1),
      isoDate(year, 5, 1),
      isoDate(year, 5, 17),
      addDays(easter, 39),
      addDays(easter, 49),
      addDays(easter, 50),
      isoDate(year, 12, 25),
      isoDate(year, 12, 26),
    ].sort();
  },
  memberImport: { dateOrder: "dmy", sources: [] },
};
