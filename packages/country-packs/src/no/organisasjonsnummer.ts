// SPDX-License-Identifier: AGPL-3.0-only
// Norwegian organisasjonsnummer (Brønnøysundregistrene): nine digits, the
// last a modulus-11 check digit (weights 3, 2, 7, 6, 5, 4, 3, 2). Canonical
// form NNN NNN NNN.

const WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];

export function normalizeOrganisasjonsnummer(input: string): string | null {
  const digits = input.replace(/\s/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const rest = sum % 11;
  const check = rest === 0 ? 0 : 11 - rest;
  if (check === 10 || check !== Number(digits[8])) return null;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
