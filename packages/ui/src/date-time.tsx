// SPDX-License-Identifier: AGPL-3.0-only
// Dates and times in a given time zone (the club's for club data), with the
// viewer's own time added when their zone differs (docs/architecture.md,
// "Locale"). Pure: renders the same on the server and in the browser.

import type { ReactNode } from "react";

export interface DateTimeFormatOptions {
  locale: string;
  timeZone: string;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
}

export function formatDateTime(value: Date | string, options: DateTimeFormatOptions): string {
  const { locale, timeZone, dateStyle, timeStyle } = options;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    ...(dateStyle ? { dateStyle } : {}),
    ...(timeStyle ? { timeStyle } : {}),
    ...(!dateStyle && !timeStyle ? { dateStyle: "medium", timeStyle: "short" } : {}),
  }).format(typeof value === "string" ? new Date(value) : value);
}

/** The zone's short name at that moment, e.g. "CET" or "GMT+1". */
export function zoneName(value: Date | string, locale: string, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone
  );
}

/** True if both zones show the same wall-clock time at that moment. */
export function sameOffset(value: Date | string, a: string, b: string): boolean {
  if (a === b) return true;
  const date = typeof value === "string" ? new Date(value) : value;
  const at = (timeZone: string) =>
    new Intl.DateTimeFormat("en", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  return at(a) === at(b);
}

export interface DateTimeProps extends DateTimeFormatOptions {
  value: Date | string;
  /** The viewer's zone; shown in addition when its time differs from `timeZone`. */
  viewerTimeZone?: string | null;
  /** Renders the viewer's time, e.g. "14:00 for you (EST)". */
  renderViewerTime?: (time: string, zone: string) => ReactNode;
}

export function DateTime({ value, viewerTimeZone, renderViewerTime, ...options }: DateTimeProps) {
  const iso = (typeof value === "string" ? new Date(value) : value).toISOString();
  const showViewer =
    viewerTimeZone && renderViewerTime && !sameOffset(value, options.timeZone, viewerTimeZone);
  return (
    <span data-time-zone={options.timeZone}>
      <time dateTime={iso}>
        {formatDateTime(value, options)} {zoneName(value, options.locale, options.timeZone)}
      </time>
      {showViewer ? (
        <span className="ml-1 text-muted" data-viewer-time-zone={viewerTimeZone}>
          {renderViewerTime(
            formatDateTime(value, { ...options, timeZone: viewerTimeZone }),
            zoneName(value, options.locale, viewerTimeZone),
          )}
        </span>
      ) : null}
    </span>
  );
}
