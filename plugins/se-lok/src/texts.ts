// SPDX-License-Identifier: AGPL-3.0-only
// Every label and reason code of the LOK plugin in sv, en and nb.

type Texts = Record<string, string>;

const sv: Texts = {
  "lok.scheme": "LOK-stöd",
  "lok.config.minMinutes": "Minsta längd i minuter (kommunens regler, minst 45)",
  "lok.outside_rules": "Före 1 juli 2025: utanför RF:s regler",
  "lok.too_short": "Kortare än den minsta längden",
  "lok.too_few_participants": "Färre än tre deltagare i åldern 6–25 år",
  "lok.no_leader": "Ingen närvarande ledare som är minst 13 år",
  "lok.over_leader_cap": "Fler än 20 deltagare per ledare: de överskjutande räknas inte",
  "lok.leader_overlap": "En ledare ledde en annan gruppaktivitet samtidigt",
  "lok.no_sport": "Gruppen har ingen idrott angiven",
  "lok.same_day": "Redan en gruppaktivitet i samma idrott samma dag",
  "lok.week_cap": "Fler tillfällen i veckan än reglerna tillåter",
  "lok.not_member": "Inte medlem i föreningen",
  "lok.age_outside": "Utanför åldrarna 6–25 år",
  "lok.no_birth_date": "Födelsedatum saknas",
  "lok.sessions": "Gruppaktiviteter som ger ledarstöd",
  "lok.extra_leader_support": "Gruppaktiviteter med två eller fler ledare (extra ledarstöd)",
  "lok.participant_occasions": "Deltagartillfällen",
  "lok.units": "Deltagarstöd i antal Z",
  "lok.pdf.rules":
    "Enligt RF:s föreskrifter om LOK-stöd, fastställda 2025-05-22. Beloppen X, Y och Z fastställs av RS varje år.",
  "lok.pdf.deadline": "Sista ansökningsdag",
};

const en: Texts = {
  "lok.scheme": "LOK grant",
  "lok.config.minMinutes": "Minimum length in minutes (the municipality's rules, at least 45)",
  "lok.outside_rules": "Before 1 July 2025: outside RF's rules",
  "lok.too_short": "Shorter than the minimum length",
  "lok.too_few_participants": "Fewer than three participants aged 6–25",
  "lok.no_leader": "No leader of at least 13 present",
  "lok.over_leader_cap": "More than 20 participants per leader: the rest do not count",
  "lok.leader_overlap": "A leader led another group activity at the same time",
  "lok.no_sport": "The group has no sport set",
  "lok.same_day": "Already a group activity in the same sport that day",
  "lok.week_cap": "More occasions in the week than the rules allow",
  "lok.not_member": "Not a member of the club",
  "lok.age_outside": "Outside the ages 6–25",
  "lok.no_birth_date": "Birth date missing",
  "lok.sessions": "Group activities giving leader support",
  "lok.extra_leader_support": "Group activities with two or more leaders (extra leader support)",
  "lok.participant_occasions": "Participant occasions",
  "lok.units": "Participant support in units of Z",
  "lok.pdf.rules":
    "Under RF's regulations on LOK grants of 2025-05-22. The amounts X, Y and Z are set by RS each year.",
  "lok.pdf.deadline": "Last day to apply",
};

const nb: Texts = {
  "lok.scheme": "LOK-støtte (Sverige)",
  "lok.config.minMinutes": "Minste lengde i minutter (kommunens regler, minst 45)",
  "lok.outside_rules": "Før 1. juli 2025: utenfor RFs regler",
  "lok.too_short": "Kortere enn minste lengde",
  "lok.too_few_participants": "Færre enn tre deltakere i alderen 6–25 år",
  "lok.no_leader": "Ingen leder på minst 13 år til stede",
  "lok.over_leader_cap": "Flere enn 20 deltakere per leder: resten teller ikke",
  "lok.leader_overlap": "En leder ledet en annen gruppeaktivitet samtidig",
  "lok.no_sport": "Gruppen har ingen idrett angitt",
  "lok.same_day": "Allerede en gruppeaktivitet i samme idrett samme dag",
  "lok.week_cap": "Flere ganger i uken enn reglene tillater",
  "lok.not_member": "Ikke medlem i klubben",
  "lok.age_outside": "Utenfor alderen 6–25 år",
  "lok.no_birth_date": "Fødselsdato mangler",
  "lok.sessions": "Gruppeaktiviteter som gir lederstøtte",
  "lok.extra_leader_support": "Gruppeaktiviteter med to eller flere ledere (ekstra lederstøtte)",
  "lok.participant_occasions": "Deltakelser",
  "lok.units": "Deltakerstøtte i antall Z",
  "lok.pdf.rules":
    "Etter RFs forskrifter om LOK-støtte fastsatt 2025-05-22. Beløpene X, Y og Z fastsettes av RS hvert år.",
  "lok.pdf.deadline": "Siste søknadsdag",
};

export const TEXTS = { sv, en, nb };
