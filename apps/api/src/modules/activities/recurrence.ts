// SPDX-License-Identifier: AGPL-3.0-only
// Recurrence of an activity series (P1.4, P1.14, ADR 0034): the sessions of a
// series' rule (shared, `@clubadmin/shared` recurrence) in a window of local
// dates, in the club's time zone, without the skipped dates and (optionally)
// the country's public holidays. Local times stay local across
// daylight-saving changes; a local time that does not exist on a day (the
// spring change) is refused.

import {
  expandRule,
  localDate,
  localTime,
  RecurrenceRuleError,
  type SeriesRule,
  type SeriesSlot,
  WEEKLY_RULE,
  zonedTime as zonedLocalTime,
} from "@clubadmin/shared";

export class RecurrenceError extends Error {
  readonly code: "invalid_recurrence" | "nonexistent_local_time";

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

/** The sessions of a series from `from` (default its first date) to `to` (default its end), in order. */
export function expandSeries(input: {
  rule?: SeriesRule | undefined;
  slots: readonly SeriesSlot[];
  startsOn: string;
  /** Null: until further notice (`to` is then required). */
  endsOn: string | null;
  from?: string | undefined;
  to?: string | undefined;
  skipDates: readonly string[];
  holidays: ReadonlySet<string>;
  timeZone: string;
}): Expansion {
  const to = input.to ?? input.endsOn;
  if (to === null) throw new RecurrenceError("invalid_recurrence");
  try {
    return expandRule({
      rule: input.rule ?? WEEKLY_RULE,
      slots: input.slots,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      from: input.from ?? input.startsOn,
      to,
      skipDates: input.skipDates,
      holidays: input.holidays,
      timeZone: input.timeZone,
    });
  } catch (error) {
    if (error instanceof RecurrenceRuleError) throw new RecurrenceError(error.code);
    throw error;
  }
}
