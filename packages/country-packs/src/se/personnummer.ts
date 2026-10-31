// SPDX-License-Identifier: AGPL-3.0-only
// Swedish personnummer and samordningsnummer (Skatteverket SKV 704/707).
// Accepted input: YYMMDD-NNNC, YYMMDD+NNNC (the "+" marks age 100 or more),
// YYYYMMDDNNNC or YYYYMMDD-NNNC. Canonical form: YYYYMMDDNNNC (12 digits).
// Samordningsnummer add 60 to the day. C is a Luhn check digit over the
// 10-digit form.

import { isCalendarDate, isoDate, type ParsedPersonalId } from "../types.ts";

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

const PATTERN = /^(\d{2})?(\d{2})(\d{2})(\d{2})([-+]?)(\d{3})(\d)$/;

export function parsePersonnummer(
  input: string,
  today: Date = new Date(),
): ParsedPersonalId | null {
  const match = PATTERN.exec(input.trim().replace(/\s/g, ""));
  if (!match) return null;
  const [, century, yy, mm, dd, separator, serial, check] = match as unknown as string[];
  if (century !== undefined && separator === "+") return null;

  const shortYear = Number(yy);
  const month = Number(mm);
  const rawDay = Number(dd);
  const coordination = rawDay > 60;
  const day = coordination ? rawDay - 60 : rawDay;

  let year: number;
  if (century !== undefined) {
    year = Number(century) * 100 + shortYear;
  } else {
    // Century from the reference date: the latest year ending in yy that is
    // not in the future, minus 100 more if the "+" separator is used.
    const currentYear = today.getUTCFullYear();
    year = currentYear - ((((currentYear - shortYear) % 100) + 100) % 100);
    if (separator === "+") year -= 100;
  }

  if (!isCalendarDate(year, month, day)) return null;
  const ten = `${yy}${mm}${dd}${serial}${check}`;
  if (!luhnValid(ten)) return null;
  const birthDate = isoDate(year, month, day);
  if (birthDate > today.toISOString().slice(0, 10)) return null;

  return {
    normalized: `${String(year).padStart(4, "0")}${mm}${dd}${serial}${check}`,
    birthDate,
    kind: coordination ? "coordination_number" : "birth_number",
  };
}
