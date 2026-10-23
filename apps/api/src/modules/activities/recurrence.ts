// SPDX-License-Identifier: AGPL-3.0-only
// Weekly recurrence of an activity series (P1.4, ADR 0034): the sessions of
// each weekday slot between two dates, in the club's time zone, without the
// skipped dates and (optionally) the country's public holidays. Local times
// stay local across daylight-saving changes; a local time that does not
// exist on a day (the spring change) is refused.

import {
  localDate,
  localTime,
  type SeriesSlot,
  zonedTime as zonedLocalTime,
} from "@clubadmin/shared";

export class RecurrenceError extends Error {
  readonly code: "invalid_recurrence" | "nonexistent_local_time" | "series_too_long";

  constructor(code: RecurrenceError["code"]) {
    super(code);
    this.name = "RecurrenceError";
    this.code = code;
  }
}

/** The instant of a local date and time; throws for a time skipped by a DST change. */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const instant = zonedLocalTime(date, time, timeZone);
  if (!instant) throw new RecurrenceError("nonexistent_local_time");
  return instant;
}

export { localDate, localTime };

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

export interface Session {
  /** The local date (the occurrence key in its series). */
  date: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Expansion {
  sessions: Session[];
  skipped: { date: string; holiday: boolean }[];
}

export const MAX_SERIES_DAYS = 400;

/** The sessions of a weekly series, in order. */
export function expandSeries(input: {
  slots: readonly SeriesSlot[];
  startsOn: string;
  endsOn: string;
  skipDates: readonly string[];
  holidays: ReadonlySet<string>;
  timeZone: string;
}): Expansion {
  const weekdays = input.slots.map((s) => s.weekday);
  if (new Set(weekdays).size !== weekdays.length || input.endsOn < input.startsOn) {
    throw new RecurrenceError("invalid_recurrence");
  }
  const days = (Date.parse(input.endsOn) - Date.parse(input.startsOn)) / 86_400_000;
  if (days > MAX_SERIES_DAYS) throw new RecurrenceError("series_too_long");
  const skip = new Set(input.skipDates);
  const byWeekday = new Map(input.slots.map((s) => [s.weekday, s]));
  const sessions: Session[] = [];
  const skipped: Expansion["skipped"] = [];
  for (let date = input.startsOn; date <= input.endsOn; date = addDays(date, 1)) {
    const slot = byWeekday.get(isoWeekday(date));
    if (!slot) continue;
    const holiday = input.holidays.has(date);
    if (skip.has(date) || holiday) {
      skipped.push({ date, holiday: holiday && !skip.has(date) });
      continue;
    }
    const startsAt = zonedTime(date, slot.startTime, input.timeZone);
    sessions.push({
      date,
      startsAt,
      endsAt: new Date(startsAt.getTime() + slot.durationMinutes * 60_000),
    });
  }
  return { sessions, skipped };
}
