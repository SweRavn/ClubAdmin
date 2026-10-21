// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Next.js puts every client component a page imports into the page's initial
// JavaScript, rendered or not. The paginated roster (TanStack Query, the API
// client) is only rendered for rosters with more than one page, so it is
// loaded through React.lazy instead (docs/performance.md).

import { type ComponentProps, lazy } from "react";

import type { GroupRoster } from "./group-roster.tsx";

const Roster = lazy(() => import("./group-roster.tsx").then((m) => ({ default: m.GroupRoster })));

export function LazyGroupRoster(props: ComponentProps<typeof GroupRoster>) {
  return <Roster {...props} />;
}
