// SPDX-License-Identifier: AGPL-3.0-only
// Who an announcement may go to from the app (P2.7g): the groups where the
// person may send (`group.announcements.send`) and the club with
// `club.announcements.send`, as the permissions endpoint lists them.

export interface PermissionsLike {
  permissions: readonly string[];
  groups: readonly { groupId: string; permissions: readonly string[] }[];
}

export function mayAnnounceToClub(p: PermissionsLike | undefined): boolean {
  return p?.permissions.includes("club.announcements.send") === true;
}

/** The groups the person may send to (all of them with the club permission). */
export function announceGroups(
  p: PermissionsLike | undefined,
  groups: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  if (!p) return [];
  if (mayAnnounceToClub(p)) return [...groups];
  const allowed = new Set(
    p.groups
      .filter((g) => g.permissions.includes("group.announcements.send"))
      .map((g) => g.groupId),
  );
  return groups.filter((g) => allowed.has(g.id));
}
