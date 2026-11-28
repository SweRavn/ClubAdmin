// SPDX-License-Identifier: AGPL-3.0-only
// The plugin's texts in sv, en and nb.

type Texts = Record<string, string>;

const sv: Texts = {
  "se.bc.extract": "Begränsat registerutdrag (arbete med barn, annan verksamhet)",
  "se.bc.basis.rf":
    "RF:s stadgar 5.8: registerutdrag för alla från 15 år med direkt och regelbunden kontakt med barn (sedan 1 januari 2020)",
  "se.bc.basis.club": "Klubbens beslut (lag 2013:852 ger rätt att begära utdraget)",
  "se.bc.too_old": "Utdraget är äldre än sex månader. Be personen beställa ett nytt.",
  "se.bc.future": "Utfärdandedatumet ligger i framtiden.",
  "se.bc.wrong_type": "Okänd typ av utdrag.",
};

const en: Texts = {
  "se.bc.extract": "Limited criminal record extract (work with children, other activities)",
  "se.bc.basis.rf":
    "RF's statutes 5.8: an extract for everyone from 15 with direct and regular contact with children (since 1 January 2020)",
  "se.bc.basis.club": "The club's decision (Act 2013:852 gives the right to ask for the extract)",
  "se.bc.too_old": "The extract is older than six months. Ask the person to order a new one.",
  "se.bc.future": "The issue date is in the future.",
  "se.bc.wrong_type": "Unknown kind of extract.",
};

const nb: Texts = {
  "se.bc.extract": "Begrenset utdrag fra belastningsregisteret (arbeid med barn, annen virksomhet)",
  "se.bc.basis.rf":
    "RFs vedtekter 5.8: utdrag for alle fra 15 år med direkte og regelmessig kontakt med barn (siden 1. januar 2020)",
  "se.bc.basis.club": "Klubbens beslutning (lov 2013:852 gir rett til å be om utdraget)",
  "se.bc.too_old": "Utdraget er eldre enn seks måneder. Be personen bestille et nytt.",
  "se.bc.future": "Utstedelsesdatoen ligger i fremtiden.",
  "se.bc.wrong_type": "Ukjent type utdrag.",
};

export const TEXTS = { sv, en, nb };
