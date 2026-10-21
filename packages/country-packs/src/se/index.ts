// SPDX-License-Identifier: AGPL-3.0-only
import { type CountryPack, personalIdFormat } from "../types.ts";
import { parsePersonnummer } from "./personnummer.ts";

export const SE: CountryPack = {
  code: "SE",
  // GDPR consent age in Sweden is 13 (Lag 2018:218, 2 kap. 4 §).
  ageRules: { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 },
  personalIdFormat: personalIdFormat(parsePersonnummer),
  localeDefaults: { locale: "sv-SE", timeZone: "Europe/Stockholm", currency: "SEK" },
};
