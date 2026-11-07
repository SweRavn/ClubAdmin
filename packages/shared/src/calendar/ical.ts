// SPDX-License-Identifier: AGPL-3.0-only
// A small iCalendar (RFC 5545) writer for calendar feeds (P1.11, ADR 0044):
// one VEVENT per activity, times in UTC, text escaped, lines folded at 75
// octets on UTF-8 boundaries, CRLF line ends. No RRULE (sessions are
// materialised) and no attendees (calendars never list people, ADR 0021).

export interface IcalEvent {
  uid: string;
  /** When the feed was written. */
  stamp: Date;
  start: Date;
  end: Date;
  /** All-day: DTSTART/DTEND as dates in `timeZone` (DTEND the day after the last). */
  allDay: boolean;
  timeZone: string;
  sequence: number;
  lastModified: Date;
  cancelled: boolean;
  summary: string;
  location?: string | null;
  geo?: { latitude: number; longitude: number } | null;
  description?: string | null;
  url?: string | null;
  categories?: string | null;
}

export interface IcalCalendar {
  /** e.g. "-//ClubAdmin//1.2.3//EN". */
  prodId: string;
  name: string;
  description?: string | null;
  timeZone: string;
  events: readonly IcalEvent[];
}

/** TEXT value escaping (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/** Folds a content line at 75 octets without splitting a UTF-8 character (RFC 5545 3.1). */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  // Continuation lines start with a space, which counts against their 75.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = 74;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261107T173000Z */
export function formatUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** 20261107: the calendar date of `date` in the time zone. */
export function formatDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function nextDay(yyyymmdd: string): string {
  const d = new Date(
    Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6)),
    ),
  );
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function event(e: IcalEvent): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${formatUtc(e.stamp)}`];
  if (e.allDay) {
    const start = formatDate(e.start, e.timeZone);
    // The end is exclusive: the day after the activity's last day.
    const lastDay = formatDate(new Date(e.end.getTime() - 1), e.timeZone);
    lines.push(
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${nextDay(lastDay < start ? start : lastDay)}`,
    );
  } else {
    lines.push(`DTSTART:${formatUtc(e.start)}`, `DTEND:${formatUtc(e.end)}`);
  }
  lines.push(
    `SEQUENCE:${e.sequence}`,
    `LAST-MODIFIED:${formatUtc(e.lastModified)}`,
    `STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${escapeText(e.summary)}`,
  );
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.geo) lines.push(`GEO:${e.geo.latitude.toFixed(6)};${e.geo.longitude.toFixed(6)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.categories) lines.push(`CATEGORIES:${escapeText(e.categories)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** The whole calendar as text (CRLF, folded). */
export function writeCalendar(calendar: IcalCalendar): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${calendar.prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timeZone}`,
    ...(calendar.description ? [`X-WR-CALDESC:${escapeText(calendar.description)}`] : []),
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...calendar.events.flatMap(event),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
