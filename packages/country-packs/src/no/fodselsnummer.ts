// SPDX-License-Identifier: AGPL-3.0-only
// Norwegian fødselsnummer and D-nummer (Skatteetaten), 11 digits DDMMYYIIICC.
// D-nummer add 40 to the day; H-nummer add 40 to the month; synthetic test
// numbers from Skatteetaten's Tenor test data add 80 to the month. The
// individual number III gives the century; CC are two mod-11 check digits.

import { isCalendarDate, isoDate, type ParsedPersonalId } from "../types.ts";

const W1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const W2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function checkDigit(digits: number[], weights: number[]): number | null {
  const sum = weights.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  const k = 11 - (sum % 11);
  if (k === 11) return 0;
  if (k === 10) return null;
  return k;
}

function century(individual: number, yy: number): number | null {
  if (individual <= 499) return 1900;
  if (individual <= 749 && yy >= 54) return 1800;
  if (individual >= 900 && yy >= 40) return 1900;
  if (individual >= 500 && yy <= 39) return 2000;
  return null;
}

export function parseFodselsnummer(
  input: string,
  today: Date = new Date(),
): ParsedPersonalId | null {
  const value = input.trim().replace(/[\s.-]/g, "");
  if (!/^\d{11}$/.test(value)) return null;
  const digits = [...value].map(Number);
  const k1 = checkDigit(digits, W1);
  const k2 = checkDigit(digits, W2);
  if (k1 === null || k2 === null || k1 !== digits[9] || k2 !== digits[10]) return null;

  let day = Number(value.slice(0, 2));
  let month = Number(value.slice(2, 4));
  const yy = Number(value.slice(4, 6));
  const individual = Number(value.slice(6, 9));

  let kind: ParsedPersonalId["kind"] = "birth_number";
  if (day > 40) {
    day -= 40;
    kind = "coordination_number";
  }
  if (month > 80) {
    month -= 80;
    kind = "test_number";
  } else if (month > 40) {
    month -= 40;
    kind = "test_number";
  }

  const base = century(individual, yy);
  if (base === null) return null;
  const year = base + yy;
  if (!isCalendarDate(year, month, day)) return null;
  const birthDate = isoDate(year, month, day);
  if (birthDate > today.toISOString().slice(0, 10)) return null;
  return { normalized: value, birthDate, kind };
}
