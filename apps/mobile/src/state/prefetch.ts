// SPDX-License-Identifier: AGPL-3.0-only
// Cache first (ADR 0040): what the person will most likely open next is
// fetched in the background while the app is open and online, so a tap
// shows it at once and it is there without coverage. Bounded: the coming
// week's activities (at most PREFETCH_ACTIVITIES, with their answers), the
// events on the schedule, the inbox and its count. Prefetched data is kept
// fresh for PREFETCH_FRESH_MS, so reopening the app does not fetch it again.

import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  activityQuery,
  eventQuery,
  responseSummaryQuery,
  type ScheduleEntry,
  useScope,
} from "../api/queries.ts";
import { useSession } from "./session.tsx";

export const PREFETCH_ACTIVITIES = 12;
export const PREFETCH_DAYS = 7;
export const PREFETCH_FRESH_MS = 10 * 60_000;

/** The schedule entries worth having before they are opened: the coming week, soonest first. */
export function prefetchTargets(
  entries: readonly ScheduleEntry[],
  now: number,
): { activities: string[]; answers: string[]; events: string[] } {
  const until = now + PREFETCH_DAYS * 86_400_000;
  const coming = entries
    .filter((e) => Date.parse(e.endsAt) > now && Date.parse(e.startsAt) < until)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, PREFETCH_ACTIVITIES);
  return {
    activities: coming.map((e) => e.activityId),
    answers: coming.filter((e) => e.responseMode !== "none").map((e) => e.activityId),
    events: [...new Set(coming.flatMap((e) => (e.eventId ? [e.eventId] : [])))],
  };
}

/** Prefetches when the schedule has arrived (and again when it changes). */
export function usePrefetch(entries: readonly ScheduleEntry[] | undefined): void {
  const client = useQueryClient();
  const { api } = useSession();
  const scope = useScope();
  const [personId, viewing] = scope;
  useEffect(() => {
    if (!entries || !personId || !onlineManager.isOnline()) return;
    const targets = prefetchTargets(entries, Date.now());
    const options = { staleTime: PREFETCH_FRESH_MS };
    for (const id of targets.activities) {
      void client.prefetchQuery({ ...activityQuery(api, scope, id), ...options });
    }
    for (const id of targets.answers) {
      void client.prefetchQuery({ ...responseSummaryQuery(api, scope, id), ...options });
    }
    for (const id of targets.events) {
      void client.prefetchQuery({ ...eventQuery(api, scope, id), ...options });
    }
    // The scope is two strings; listing them keeps the effect from running on every render.
  }, [entries, client, api, personId, viewing]);
}
