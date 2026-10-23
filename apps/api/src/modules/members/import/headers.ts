// SPDX-License-Identifier: AGPL-3.0-only
// Recognising the columns of an import file (P1.3b): headers in Swedish,
// English and Norwegian, guardian column groups (`Vårdnadshavare 2 e-post`,
// `Guardian 3 phone`, `Foresatt 1 fornavn`, any number of them), and the
// member systems of the club's country pack (IdrottOnline in `se`). Unknown
// columns are left unmapped (the preview shows them). Fields are the
// import's target names (strings), not person data.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import { type MemberImportColumnMap, parseImportTarget } from "@clubadmin/shared";

/** Lower case, single spaces, no surrounding punctuation. */
export const normaliseHeader = (header: string): string =>
  header
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/^[\s:#*-]+|[\s:#*]+$/g, "")
    .trim();

const MEMBER_HEADERS: readonly (readonly [string, readonly string[]])[] = [
  ["givenName", ["förnamn", "tilltalsnamn", "first name", "firstname", "given name", "fornavn"]],
  ["familyName", ["efternamn", "last name", "lastname", "surname", "family name", "etternavn"]],
  ["fullName", ["namn", "name", "full name", "fullständigt namn", "navn", "fullt navn"]],
  [
    "birthDate",
    [
      "födelsedatum",
      "född",
      "födelsedag",
      "date of birth",
      "birth date",
      "birthdate",
      "dob",
      "fødselsdato",
      "født",
    ],
  ],
  [
    "personalIdentityNumber",
    [
      "personnummer",
      "personnr",
      "pnr",
      "personal identity number",
      "national id",
      "national identity number",
      "fødselsnummer",
      "personnummer/samordningsnummer",
    ],
  ],
  ["gender", ["kön", "gender", "sex", "kjønn"]],
  [
    "phone",
    [
      "telefon",
      "mobil",
      "mobilnummer",
      "telefonnummer",
      "phone",
      "mobile",
      "telephone",
      "phone number",
      "mobile phone",
    ],
  ],
  [
    "email",
    [
      "e-post",
      "epost",
      "e-postadress",
      "mejl",
      "email",
      "e-mail",
      "email address",
      "e-mail address",
    ],
  ],
  [
    "street",
    [
      "adress",
      "gatuadress",
      "utdelningsadress",
      "address",
      "street",
      "street address",
      "adresse",
      "gateadresse",
    ],
  ],
  ["postalCode", ["postnummer", "post code", "postal code", "postcode", "zip", "zip code"]],
  ["city", ["ort", "postort", "stad", "city", "town", "poststed", "sted"]],
  ["membershipType", ["medlemstyp", "medlemskap", "membership type", "member type", "medlemstype"]],
  [
    "startDate",
    [
      "medlem sedan",
      "startdatum",
      "inträdesdatum",
      "member since",
      "start date",
      "joined",
      "medlem siden",
      "innmeldt",
      "innmeldingsdato",
    ],
  ],
  [
    "memberNumber",
    ["medlemsnummer", "medlemsnr", "member number", "member no", "membership number"],
  ],
  [
    "groups",
    ["grupp", "grupper", "lag", "träningsgrupp", "group", "groups", "team", "teams", "gruppe"],
  ],
  [
    "protected",
    [
      "skyddad identitet",
      "skyddade personuppgifter",
      "sekretessmarkering",
      "protected",
      "protected identity",
      "skjermet",
      "fortrolig adresse",
    ],
  ],
  [
    "familyKey",
    [
      "familj",
      "familje-id",
      "familjenummer",
      "hushåll",
      "family",
      "family id",
      "household",
      "familie",
      "familie-id",
    ],
  ],
  ["relation", ["relation", "relationship", "relasjon", "relation till barnet"]],
];

const GUARDIAN_WORDS = [
  "vårdnadshavare",
  "målsman",
  "förälder",
  "guardian",
  "parent",
  "foresatt",
  "forelder",
];

const GUARDIAN_SUBFIELDS: readonly (readonly [string, readonly string[]])[] = [
  ["givenName", ["förnamn", "first name", "firstname", "given name", "fornavn"]],
  ["familyName", ["efternamn", "last name", "lastname", "surname", "family name", "etternavn"]],
  ["fullName", ["namn", "name", "navn"]],
  ["phone", ["telefon", "mobil", "mobilnummer", "phone", "mobile", "telefonnummer"]],
  ["email", ["e-post", "epost", "email", "e-mail", "mejl"]],
  ["kind", ["relation", "typ", "kind", "type", "relasjon", "relationship"]],
];

const MEMBER_LOOKUP = new Map(
  MEMBER_HEADERS.flatMap(([field, names]) => names.map((n) => [n, field] as const)),
);

/** `vårdnadshavare 2 e-post`, `guardian 1 phone`, `e-post vårdnadshavare 2`, `målsman förnamn` (1). */
function guardianTarget(header: string): string | null {
  const word = GUARDIAN_WORDS.find((w) => header.includes(w));
  if (!word) return null;
  const number = /\b([1-9][0-9]?)\b/.exec(header);
  const rest = header
    .replace(word, " ")
    .replace(/\b[1-9][0-9]?\b/, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [field, names] of GUARDIAN_SUBFIELDS) {
    if (names.includes(rest)) return `guardian.${number ? number[1] : "1"}.${field}`;
  }
  // "Vårdnadshavare 1" alone is the guardian's full name.
  if (rest === "") return `guardian.${number ? number[1] : "1"}.fullName`;
  return null;
}

export interface SuggestedMapping {
  columnMap: MemberImportColumnMap;
  detectedSource: string | null;
  suggestions: (string | null)[];
}

/** Suggested fields per column; each field once (the first column that has it). */
export function suggestMapping(headers: readonly string[], country: string): SuggestedMapping {
  const normalised = headers.map(normaliseHeader);
  const sources = isSupportedCountry(country) ? getCountryPack(country).memberImport.sources : [];
  const source = sources.find((s) => normalised.includes(s.marker)) ?? null;
  const used = new Set<string>();
  const columnMap: MemberImportColumnMap = {};
  const suggestions = normalised.map((header, index) => {
    const target =
      source?.headers[header] ?? MEMBER_LOOKUP.get(header) ?? guardianTarget(header) ?? null;
    if (!target || !parseImportTarget(target) || used.has(target)) return null;
    used.add(target);
    columnMap[String(index)] = target;
    return target;
  });
  return { columnMap, detectedSource: source?.name ?? null, suggestions };
}
