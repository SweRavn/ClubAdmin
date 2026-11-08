// SPDX-License-Identifier: AGPL-3.0-only
// Recurrence of activity series (P1.4, P1.14, ADR 0034): a strict subset of
// RFC 5545 RRULE, evaluated in the club's time zone.
//
// - FREQ=DAILY;INTERVAL=n: every n days from the first date;
// - FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,WE: the weekly slots (a start time and
//   length per weekday), every n weeks counted from the first date's week;
// - FREQ=MONTHLY;INTERVAL=n;BYDAY=1WE,-1FR: weekdays by position in the
//   month ("first Wednesday", "last Friday");
// - FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=15: days of the month (a month
//   without the day skips it, as calendars do).
//
// No YEARLY, no COUNT, no BYSETPOS (P1.14 decision 5). Local times stay local
// across daylight-saving changes; a time that does not exist on a day (the
// spring change) is refused. Pure: the API, the web's preview and the tests
// share it.

import { zonedTime } from "./zoned-time.ts";

export const RECURRENCE_FREQS = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

/** Positions of a weekday in a month: first … fourth, and last (−1). */
export const WEEKDAY_ORDINALS = [1, 2, 3, 4, -1] as const;
export type WeekdayOrdinal = (typeof WEEKDAY_ORDINALS)[number];

export interface WeeklySlot {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  startTime: string;
  durationMinutes: number;
}

export interface SeriesRule {
  freq: RecurrenceFreq;
  interval: number;
  /** Monthly by position: weekday and ordinal ("2nd Tuesday"). */
  byDay?: { weekday: number; ordinal: WeekdayOrdinal }[] | undefined;
  /** Monthly by day of the month. */
  byMonthDay?: number[] | undefined;
  /** Daily and monthly rules: the local start time and length of every session. */
  startTime?: string | undefined;
  durationMinutes?: number | undefined;
}

/** The weekly rule of the series before P1.14 (their slots give the days). */
export const WEEKLY_RULE: SeriesRule = { freq: "weekly", interval: 1 };

/** How far ahead sessions of a series exist (P1.14 decision 3: 13 months). */
export const SERIES_HORIZON_DAYS = 396;

export type RecurrenceErrorCode = "invalid_recurrence" | "nonexistent_local_time";

export class RecurrenceRuleError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(code: RecurrenceErrorCode) {
    super(code);
    this.name = "RecurrenceRuleError";
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const RRULE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/** ISO weekday of a date (1 = Monday). */
export const isoWeekday = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Problems with a rule and its slots, or null when it can be evaluated. */
export function ruleProblem(rule: SeriesRule, slots: readonly WeeklySlot[]): string | null {
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 52) {
    return "interval";
  }
  const timed = rule.startTime !== undefined && rule.durationMinutes !== undefined;
  switch (rule.freq) {
    case "weekly": {
      if (rule.byDay?.length || rule.byMonthDay?.length) return "weekly_by";
      const weekdays = slots.map((s) => s.weekday);
      if (weekdays.length === 0) return "no_slots";
      if (new Set(weekdays).size !== weekdays.length) return "duplicate_weekday";
      return null;
    }
    case "daily":
      if (rule.byDay?.length || rule.byMonthDay?.length) return "daily_by";
      return timed ? null : "no_time";
    case "monthly": {
      const byDay = rule.byDay?.length ?? 0;
      const byMonthDay = rule.byMonthDay?.length ?? 0;
      if ((byDay === 0) === (byMonthDay === 0)) return "monthly_by";
      return timed ? null : "no_time";
    }
  }
}

/** The days of a month a monthly rule picks (sorted, distinct). */
function monthlyDays(rule: SeriesRule, year: number, month: number): number[] {
  const length = daysInMonth(year, month);
  const days = new Set<number>();
  for (const d of rule.byMonthDay ?? []) if (d <= length) days.add(d);
  for (const { weekday, ordinal } of rule.byDay ?? []) {
    const first = isoWeekday(`${year}-${String(month).padStart(2, "0")}-01`);
    const firstMatch = 1 + ((weekday - first + 7) % 7);
    if (ordinal === -1) {
      let last = firstMatch;
      while (last + 7 <= length) last += 7;
      days.add(last);
    } else {
      const day = firstMatch + (ordinal - 1) * 7;
      if (day <= length) days.add(day);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** The dates of a rule's pattern from `from` to `to` (inclusive), never before `startsOn`. */
export function ruleDates(
  rule: SeriesRule,
  slots: readonly WeeklySlot[],
  startsOn: string,
  from: string,
  to: string,
): string[] {
  if (ruleProblem(rule, slots)) throw new RecurrenceRuleError("invalid_recurrence");
  const first = from < startsOn ? startsOn : from;
  const dates: string[] = [];
  if (first > to) return dates;
  if (rule.freq === "daily") {
    const offset = (dayNumber(first) - dayNumber(startsOn)) % rule.interval;
    for (
      let date = offset === 0 ? first : addDays(first, rule.interval - offset);
      date <= to;
      date = addDays(date, rule.interval)
    ) {
      dates.push(date);
    }
    return dates;
  }
  if (rule.freq === "weekly") {
    const weekdays = new Set(slots.map((s) => s.weekday));
    // Weeks counted from the Monday of the first date's week.
    const monday = (date: string) => dayNumber(date) - (isoWeekday(date) - 1);
    const base = monday(startsOn);
    for (let date = first; date <= to; date = addDays(date, 1)) {
      if (!weekdays.has(isoWeekday(date))) continue;
      if (((monday(date) - base) / 7) % rule.interval !== 0) continue;
      dates.push(date);
    }
    return dates;
  }
  // Monthly: months counted from the first date's month.
  const startYear = Number(startsOn.slice(0, 4));
  const startMonth = Number(startsOn.slice(5, 7));
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  const index = (y: number, m: number) => (y - startYear) * 12 + (m - startMonth);
  while (`${year}-${String(month).padStart(2, "0")}-01` <= to) {
    if (index(year, month) % rule.interval === 0) {
      for (const day of monthlyDays(rule, year, month)) {
        const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (date >= first && date <= to) dates.push(date);
      }
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return dates;
}

/** The local start time and length of a session on a date. */
function timeOn(
  rule: SeriesRule,
  slots: readonly WeeklySlot[],
  date: string,
): { startTime: string; durationMinutes: number } {
  if (rule.freq === "weekly") {
    const slot = slots.find((s) => s.weekday === isoWeekday(date))!;
    return slot;
  }
  return { startTime: rule.startTime!, durationMinutes: rule.durationMinutes! };
}

export interface RuleSession {
  /** The local date (the occurrence key in its series). */
  date: string;
  startsAt: Date;
  endsAt: Date;
}

export interface RuleExpansion {
  sessions: RuleSession[];
  /** Dates of the pattern left out: skipped dates and public holidays. */
  skipped: { date: string; holiday: boolean }[];
}

/** The sessions of a series from `from` to `to` (inclusive local dates), in order. */
export function expandRule(input: {
  rule: SeriesRule;
  slots: readonly WeeklySlot[];
  startsOn: string;
  /** Null: until further notice. */
  endsOn: string | null;
  from: string;
  to: string;
  skipDates: readonly string[];
  holidays: ReadonlySet<string>;
  timeZone: string;
}): RuleExpansion {
  if (input.endsOn !== null && input.endsOn < input.startsOn) {
    throw new RecurrenceRuleError("invalid_recurrence");
  }
  const to = input.endsOn !== null && input.endsOn < input.to ? input.endsOn : input.to;
  const skip = new Set(input.skipDates);
  const sessions: RuleSession[] = [];
  const skipped: RuleExpansion["skipped"] = [];
  for (const date of ruleDates(input.rule, input.slots, input.startsOn, input.from, to)) {
    const holiday = input.holidays.has(date);
    if (skip.has(date) || holiday) {
      skipped.push({ date, holiday: holiday && !skip.has(date) });
      continue;
    }
    const { startTime, durationMinutes } = timeOn(input.rule, input.slots, date);
    const startsAt = zonedTime(date, startTime, input.timeZone);
    if (!startsAt) throw new RecurrenceRuleError("nonexistent_local_time");
    sessions.push({
      date,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
    });
  }
  return { sessions, skipped };
}

/** The rule as an RFC 5545 RRULE value (for calendars and the API's `rrule`). */
export function formatRRule(
  rule: SeriesRule,
  slots: readonly WeeklySlot[],
  until: string | null,
): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === "weekly") {
    const days = [...slots].sort((a, b) => a.weekday - b.weekday);
    parts.push(`BYDAY=${days.map((s) => RRULE_DAYS[s.weekday - 1]).join(",")}`);
  }
  if (rule.byDay?.length) {
    parts.push(
      `BYDAY=${rule.byDay.map((d) => `${d.ordinal}${RRULE_DAYS[d.weekday - 1]}`).join(",")}`,
    );
  }
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (until) parts.push(`UNTIL=${until.replaceAll("-", "")}`);
  return parts.join(";");
}

// --- Answer requests (P1.14) ----------------------------------------------------

/** When the group is asked to answer: N days before at a local time, or N hours before. */
export type RequestLead =
  { kind: "days"; days: number; time: string } | { kind: "hours"; hours: number };

/** The moment a session's answer request goes out (null: no request). */
export function requestAt(
  lead: RequestLead | null | undefined,
  startsAt: Date,
  timeZone: string,
): Date | null {
  if (!lead) return null;
  if (lead.kind === "hours") return new Date(startsAt.getTime() - lead.hours * 3_600_000);
  const day = new Date(startsAt.getTime());
  // The session's local date, then N days before, at the local time.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(day);
  const date = addDays(local, -lead.days);
  // A time skipped by DST that day: an hour later, as calendars do.
  const hour = (Number(lead.time.slice(0, 2)) + 1) % 24;
  const later = `${String(hour).padStart(2, "0")}${lead.time.slice(2)}`;
  const at = zonedTime(date, lead.time, timeZone) ?? zonedTime(date, later, timeZone) ?? day;
  // Never after the start itself (same day, a time after the start).
  return at.getTime() > startsAt.getTime() ? startsAt : at;
}
