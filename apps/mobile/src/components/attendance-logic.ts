// SPDX-License-Identifier: AGPL-3.0-only
// Which sessions wait for attendance (P2.7g), and who leads a group.

/** A group function that takes attendance (leaders; not members or the physio). */
export function isLeaderFunction(fn: string): boolean {
  return fn !== "member" && fn !== "physio";
}

export interface SessionLike {
  activityId: string;
  startsAt: string;
  recorded: boolean;
}

/**
 * The sessions that have started and have no marks, newest first; a joint
 * session of two of my groups once.
 */
export function waitingSessions<T extends SessionLike>(sessions: readonly T[], now: number): T[] {
  const seen = new Set<string>();
  return sessions
    .filter((s) => !s.recorded && Date.parse(s.startsAt) <= now)
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .filter((s) => (seen.has(s.activityId) ? false : (seen.add(s.activityId), true)));
}
