// SPDX-License-Identifier: AGPL-3.0-only
import {
  addDays,
  type CountryPack,
  easterSunday,
  firstWeekdayFrom,
  isoDate,
  personalIdFormat,
} from "../types.ts";
import { parsePersonnummer } from "./personnummer.ts";

export const SE: CountryPack = {
  code: "SE",
  // GDPR consent age in Sweden is 13 (Lag 2018:218, 2 kap. 4 §).
  ageRules: { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 },
  personalIdFormat: personalIdFormat(parsePersonnummer),
  localeDefaults: { locale: "sv-SE", timeZone: "Europe/Stockholm", currency: "SEK" },
  // Allmänna helgdagar (lag 1989:253) and the eves that are de facto days off
  // (midsommarafton, julafton, nyårsafton).
  publicHolidays(year) {
    const easter = easterSunday(year);
    const midsummer = firstWeekdayFrom(year, 6, 20, 6);
    return [
      isoDate(year, 1, 1),
      isoDate(year, 1, 6),
      addDays(easter, -2),
      addDays(easter, 0),
      addDays(easter, 1),
      isoDate(year, 5, 1),
      addDays(easter, 39),
      addDays(easter, 49),
      isoDate(year, 6, 6),
      addDays(new Date(`${midsummer}T00:00:00Z`), -1),
      midsummer,
      firstWeekdayFrom(year, 10, 31, 6),
      isoDate(year, 12, 24),
      isoDate(year, 12, 25),
      isoDate(year, 12, 26),
      isoDate(year, 12, 31),
    ].sort();
  },
  memberImport: {
    dateOrder: "dmy",
    sources: [
      {
        // The member export of IdrottOnline (Riksidrottsförbundet).
        name: "idrottonline",
        marker: "idrottsid",
        headers: {
          "födelsedat./personnr.": "personalIdentityNumber",
          "födelsedatum/personnummer": "personalIdentityNumber",
          "telefon mobil": "phone",
          mobiltelefon: "phone",
          "e-post kontakt": "email",
          "e-post privat": "email",
          adress: "street",
          postnr: "postalCode",
          "medlem sedan": "startDate",
          "datum medlemskap": "startDate",
          "lag/grupp": "groups",
          "lag/grupper": "groups",
          "målsman 1 förnamn": "guardian.1.givenName",
          "målsman 1 efternamn": "guardian.1.familyName",
          "målsman 1 mobil": "guardian.1.phone",
          "målsman 1 e-post": "guardian.1.email",
          "målsman 2 förnamn": "guardian.2.givenName",
          "målsman 2 efternamn": "guardian.2.familyName",
          "målsman 2 mobil": "guardian.2.phone",
          "målsman 2 e-post": "guardian.2.email",
        },
      },
    ],
  },
};
