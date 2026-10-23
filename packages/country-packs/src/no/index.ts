// SPDX-License-Identifier: AGPL-3.0-only
import { type CountryPack, personalIdFormat } from "../types.ts";
import { parseFodselsnummer } from "./fodselsnummer.ts";

export const NO: CountryPack = {
  code: "NO",
  // GDPR consent age in Norway is 13 (personopplysningsloven § 5).
  ageRules: { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 },
  personalIdFormat: personalIdFormat(parseFodselsnummer),
  localeDefaults: { locale: "nb-NO", timeZone: "Europe/Oslo", currency: "NOK" },
  memberImport: { dateOrder: "dmy", sources: [] },
};
