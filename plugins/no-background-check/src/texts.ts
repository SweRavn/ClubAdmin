// SPDX-License-Identifier: AGPL-3.0-only
// The plugin's texts in sv, en and nb.

type Texts = Record<string, string>;

const nb: Texts = {
  "no.bc.attest": "Politiattest for barneomsorg (politiregisterloven § 39)",
  "no.bc.basis.nif":
    "Idrettsstyrets vedtak (sak 185, 2017) og politiregisterforskriften § 34-1: merknadsfri politiattest for oppgaver med tillit eller ansvar overfor mindreårige",
  "no.bc.basis.club": "Klubbens beslutning (styret avgjør for andre verv)",
  "no.bc.future": "Utstedelsesdatoen ligger i fremtiden.",
  "no.bc.wrong_type": "Ukjent type attest.",
};

const sv: Texts = {
  "no.bc.attest": "Politiattest för barnomsorg (politiregisterloven § 39)",
  "no.bc.basis.nif":
    "Idrettsstyrets beslut (ärende 185, 2017) och politiregisterforskriften § 34-1: politiattest utan anmärkning för uppdrag med förtroende eller ansvar för minderåriga",
  "no.bc.basis.club": "Klubbens beslut (styrelsen avgör för andra uppdrag)",
  "no.bc.future": "Utfärdandedatumet ligger i framtiden.",
  "no.bc.wrong_type": "Okänd typ av attest.",
};

const en: Texts = {
  "no.bc.attest": "Police certificate for child care (Police Records Act § 39)",
  "no.bc.basis.nif":
    "The NIF board's decision (case 185, 2017) and the Police Records Regulations § 34-1: a certificate without remarks for tasks of trust or responsibility towards minors",
  "no.bc.basis.club": "The club's decision (the board decides for other tasks)",
  "no.bc.future": "The issue date is in the future.",
  "no.bc.wrong_type": "Unknown kind of certificate.",
};

export const TEXTS = { sv, en, nb };
