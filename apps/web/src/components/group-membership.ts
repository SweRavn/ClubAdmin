// SPDX-License-Identifier: AGPL-3.0-only
// Who of the viewer and the wards they act for is already in a group (P2.7b):
// the join and waiting-list actions are only offered for the others.
import type { MyGroups } from "@clubadmin/shared";

export function membersOfGroup(myGroups: MyGroups, me: string, groupId: string): Set<string> {
  const inGroup = new Set<string>();
  if (myGroups.groups.some((g) => g.group.id === groupId)) inGroup.add(me);
  for (const ward of myGroups.wards) {
    if (ward.groups.some((g) => g.group.id === groupId)) inGroup.add(ward.personId);
  }
  return inGroup;
}
