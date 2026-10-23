// SPDX-License-Identifier: AGPL-3.0-only
// "My schedule" by day for the start screen (P1.4).

import { localDate } from "@clubadmin/shared";

import type { ScheduleEntry } from "../api/queries.ts";

/** Entries by local date (each in its club's time zone), leaving out what has ended. */
export function scheduleDays(
  items: readonly ScheduleEntry[],
  person: string | null,
  now: number,
): { date: string; items: ScheduleEntry[] }[] {
  const days: { date: string; items: ScheduleEntry[] }[] = [];
  for (const item of items) {
    if (Date.parse(item.endsAt) < now) continue;
    if (person && !item.people.some((p) => p.id === person)) continue;
    const date = localDate(new Date(item.startsAt), item.club.timeZone);
    const day = days.at(-1);
    if (day?.date === date) day.items.push(item);
    else days.push({ date, items: [item] });
  }
  return days;
}
