// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type CountryPack, easterSunday, isoDate, personalIdFormat } from "../types.ts";
import { parseFodselsnummer } from "./fodselsnummer.ts";
import { normalizeOrganisasjonsnummer } from "./organisasjonsnummer.ts";

export const NO: CountryPack = {
  code: "NO",
  // GDPR consent age in Norway is 13 (personopplysningsloven § 5).
  ageRules: { consentAge: 13, ownAccountMinAge: 13, adultAge: 18, childSelfBookingAge: 13 },
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
  agendaTemplates: [
    {
      // Norges idrettsforbunds lovnorm for idrettslag (årsmøte).
      key: "no.annual_meeting",
      meetingKind: "annual_meeting",
      name: "Årsmøte",
      items: [
        { title: "Godkjenne de stemmeberettigede" },
        { title: "Godkjenne innkallingen" },
        { title: "Godkjenne saklisten" },
        { title: "Godkjenne forretningsorden" },
        { title: "Velge dirigent, referent og to medlemmer til å underskrive protokollen" },
        { title: "Behandle idrettslagets årsberetning" },
        { title: "Behandle idrettslagets regnskap" },
        { title: "Behandle forslag og saker" },
        { title: "Fastsette medlemskontingent" },
        { title: "Vedta idrettslagets budsjett" },
        { title: "Behandle idrettslagets organisasjonsplan" },
        { title: "Valg" },
      ],
    },
    {
      key: "no.board_meeting",
      meetingKind: "board_meeting",
      name: "Styremøte",
      items: [
        { title: "Godkjenning av innkalling og saksliste" },
        { title: "Godkjenning av protokoll fra forrige møte" },
        { title: "Økonomi" },
        { title: "Orienteringssaker" },
        { title: "Vedtakssaker" },
        { title: "Eventuelt" },
        { title: "Neste møte" },
      ],
    },
  ],
  memberImport: { dateOrder: "dmy", sources: [] },
};
