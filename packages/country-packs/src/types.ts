// SPDX-License-Identifier: AGPL-3.0-only
// Country pack interfaces (ADR 0015). The core never branches on country
// codes; it asks the club's pack. Packs are pure functions and data.

export interface AgeRules {
  /** Age from which a person can consent to data processing themselves. */
  consentAge: number;
  /** Age from which a person may have their own login and email (ADR 0020). */
  ownAccountMinAge: number;
  /** Age at which guardians' default rights end. */
  adultAge: number;
}

export interface ParsedPersonalId {
  /** Canonical form, stored (encrypted) and used for the duplicate-matching hash. */
  normalized: string;
  /** Date of birth encoded in the number (ISO yyyy-mm-dd). */
  birthDate: string;
  /** Coordination/D-numbers and synthetic test numbers are not regular birth numbers. */
  kind: "birth_number" | "coordination_number" | "test_number";
}

export interface PersonalIdFormat {
  /** Parses and validates (checksum, date). Returns null for invalid input; never throws. */
  parse(input: string, today?: Date): ParsedPersonalId | null;
  isValid(input: string, today?: Date): boolean;
  /** Canonical form, or null if invalid. */
  normalize(input: string, today?: Date): string | null;
}

export interface LocaleDefaults {
  /** BCP 47 locale, e.g. sv-SE. */
  locale: string;
  /** IANA time zone. */
  timeZone: string;
  /** ISO 4217 currency code. */
  currency: string;
}

/**
 * Member imports (P1.3b): how dates are written in the country's files and
 * the column names of the country's member systems (normalised: lower case,
 * single spaces). Field names are the import's (`givenName`,
 * `guardian.1.email`, …); generic sv/en/nb headers are the API's.
 */
export interface MemberImportRules {
  /** Day-month-year (02.04.2017) or month-day-year; ISO dates always work. */
  dateOrder: "dmy" | "mdy";
  sources: readonly {
    /** Recognised format, e.g. "idrottonline". */
    name: string;
    /** A header only this format has. */
    marker: string;
    headers: Readonly<Record<string, string>>;
  }[];
}

export interface CountryPack {
  /** ISO 3166-1 alpha-2. */
  code: string;
  ageRules: AgeRules;
  personalIdFormat: PersonalIdFormat;
  localeDefaults: LocaleDefaults;
  memberImport: MemberImportRules;
  /**
   * Days the club's activities usually pause (P1.4): public holidays and the
   * eves that are de facto days off. ISO dates of the year, sorted.
   */
  publicHolidays(year: number): string[];
}

/** Shared helper: builds isValid/normalize from parse. */
export function personalIdFormat(
  parse: (input: string, today?: Date) => ParsedPersonalId | null,
): PersonalIdFormat {
  return {
    parse,
    isValid: (input, today) => parse(input, today) !== null,
    normalize: (input, today) => parse(input, today)?.normalized ?? null,
  };
}

/** True if year/month/day form a real calendar date. */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const isoDate = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** Easter Sunday (Gregorian, anonymous algorithm) as UTC midnight. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** The ISO date `days` after (or before) a UTC date. */
export function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The first date from `from` (month, day) that falls on an ISO weekday (1 Monday … 7 Sunday). */
export function firstWeekdayFrom(
  year: number,
  month: number,
  day: number,
  weekday: number,
): string {
  const start = new Date(Date.UTC(year, month - 1, day));
  const current = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  return addDays(start, (weekday - current + 7) % 7);
}
