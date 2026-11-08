// SPDX-License-Identifier: AGPL-3.0-only
// The recurrence and answer-request fields of the series forms (P1.14), read
// the same way from a posted form (create, change, split) and from the
// preview's query string: how it repeats, when it ends, and when the group
// is asked to answer. Invalid input gives null; the API validates again.

import type { RequestLead, SeriesRule, SeriesSlot } from "@clubadmin/shared";

type Get = (name: string) => string;

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const int = (value: string, min: number, max: number): number | null => {
  const n = Number(value);
  return value !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Up to this many weekly slot rows and monthly position rows in the form. */
export const SLOT_ROWS = 3;
export const POSITION_ROWS = 2;

/** Weekly slots from the rows weekday.N, startTime.N, duration.N (empty rows are skipped). */
export function slotsFrom(get: Get): SeriesSlot[] | null {
  const slots: SeriesSlot[] = [];
  for (let n = 0; n < 7; n++) {
    const weekday = Number(get(`weekday.${n}`));
    const startTime = get(`startTime.${n}`);
    if (!weekday || !startTime) continue;
    const duration = int(get(`duration.${n}`) || "90", 15, 720);
    if (!isTime(startTime) || duration === null || weekday < 1 || weekday > 7) return null;
    slots.push({ weekday, startTime, durationMinutes: duration });
  }
  return slots;
}

export interface RecurrenceFields {
  rule: SeriesRule;
  slots: SeriesSlot[];
  /** Null: until further notice; undefined: not in the form. */
  endsOn: string | null | undefined;
}

/** How the series repeats and when it ends, or null when the fields do not fit. */
export function recurrenceFrom(get: Get): RecurrenceFields | null {
  const slots = slotsFrom(get);
  if (slots === null) return null;
  const freq = get("freq") || "weekly";
  const interval = int(get("interval") || "1", 1, 52);
  if (interval === null) return null;
  // "never": until further notice; "date" (or no choice, as before P1.14): the end date.
  const endMode = get("endMode");
  const endsOn = endMode === "never" ? null : isDate(get("endsOn")) ? get("endsOn") : undefined;
  if (endMode === "date" && endsOn === undefined) return null;
  if (freq === "weekly") {
    return { rule: { freq: "weekly", interval }, slots, endsOn };
  }
  const startTime = get("ruleTime");
  const durationMinutes = int(get("ruleDuration") || "90", 15, 720);
  if (!isTime(startTime) || durationMinutes === null) return null;
  if (freq === "daily") {
    return { rule: { freq: "daily", interval, startTime, durationMinutes }, slots: [], endsOn };
  }
  if (freq !== "monthly") return null;
  if (get("monthlyBy") === "day") {
    const days = get("monthDays")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((d) => int(d, 1, 31));
    if (days.length === 0 || days.some((d) => d === null)) return null;
    return {
      rule: {
        freq: "monthly",
        interval,
        byMonthDay: [...new Set(days as number[])].sort((a, b) => a - b),
        startTime,
        durationMinutes,
      },
      slots: [],
      endsOn,
    };
  }
  const byDay: { weekday: number; ordinal: 1 | 2 | 3 | 4 | -1 }[] = [];
  for (let n = 0; n < POSITION_ROWS; n++) {
    const ordinal = get(`ordinal.${n}`);
    const weekday = int(get(`posWeekday.${n}`), 1, 7);
    if (!ordinal || weekday === null) continue;
    const value = ordinal === "last" ? -1 : int(ordinal, 1, 4);
    if (value === null) return null;
    byDay.push({ weekday, ordinal: value as 1 | 2 | 3 | 4 | -1 });
  }
  if (byDay.length === 0) return null;
  return {
    rule: { freq: "monthly", interval, byDay, startTime, durationMinutes },
    slots: [],
    endsOn,
  };
}

/** The answer request: null for none, undefined when the fields are invalid. */
export function requestLeadFrom(get: Get): RequestLead | null | undefined {
  const kind = get("requestKind");
  if (kind === "" || kind === "none") return null;
  if (kind === "days") {
    const days = int(get("requestDays"), 0, 14);
    const time = get("requestTime");
    return days !== null && isTime(time) ? { kind: "days", days, time } : undefined;
  }
  if (kind === "hours") {
    const hours = int(get("requestHours"), 1, 72);
    return hours !== null ? { kind: "hours", hours } : undefined;
  }
  return undefined;
}
