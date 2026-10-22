// SPDX-License-Identifier: AGPL-3.0-only
// The club's groups as a tree for display.

import type { Group } from "../api/queries.ts";

/** Depth-first order with each group's depth, children after their parent. */
export function groupTree(groups: Group[]): { group: Group; depth: number }[] {
  const children = new Map<string | null, Group[]>();
  const ids = new Set(groups.map((g) => g.id));
  for (const group of groups) {
    // A parent the viewer cannot see makes the group a root here.
    const parent = group.parentGroupId && ids.has(group.parentGroupId) ? group.parentGroupId : null;
    children.set(parent, [...(children.get(parent) ?? []), group]);
  }
  const out: { group: Group; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const group of list) {
      out.push({ group, depth });
      walk(group.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
