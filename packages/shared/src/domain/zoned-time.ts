// SPDX-License-Identifier: AGPL-3.0-only
// Local dates and times in a time zone (P1.4): activities are entered in the
// club's time zone and stored in UTC. Intl only (no time zone database of
// our own); used by the API's recurrence and the web's activity forms.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time in a zone at an instant, as if it were UTC (ms). */
function wallClock(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * The instant of a local date and time in a zone, or null for a time skipped
 * by a DST change; an ambiguous one (the autumn change) is the first of the
 * two.
 */
export function zonedTime(date: string, time: string, timeZone: string): Date | null {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const local = Date.UTC(y, m - 1, d, h, mi);
  // Two rounds settle the offset at the instant itself.
  let utc = local - (wallClock(local, timeZone) - local);
  utc = local - (wallClock(utc, timeZone) - utc);
  // The earlier of two candidates for an ambiguous time.
  const earlier = utc - 3_600_000;
  if (wallClock(earlier, timeZone) === local) utc = earlier;
  if (wallClock(utc, timeZone) !== local) return null;
  return new Date(utc);
}

/** The local calendar date of an instant in a zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Date(wallClock(instant.getTime(), timeZone)).toISOString().slice(0, 10);
}

/** The local time (HH:MM) of an instant in a zone. */
export function localTime(instant: Date, timeZone: string): string {
  return new Date(wallClock(instant.getTime(), timeZone)).toISOString().slice(11, 16);
}
