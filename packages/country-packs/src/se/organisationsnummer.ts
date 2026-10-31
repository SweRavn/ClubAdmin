// SPDX-License-Identifier: AGPL-3.0-only
// Swedish organisationsnummer (Bolagsverket, Skatteverket SKV 709): ten
// digits NNNNNN-NNNC, C a Luhn check digit; the third digit is 2 or more for
// legal persons (ideella föreningar start with 8). Canonical form NNNNNN-NNNN.

import { luhnValid } from "./personnummer.ts";

export function normalizeOrganisationsnummer(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(digits) || Number(digits[2]) < 2 || !luhnValid(digits)) return null;
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}
