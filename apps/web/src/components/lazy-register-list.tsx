// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The paginated register is only rendered for lists with more than one page:
// loaded through React.lazy so other pages do not carry its JavaScript
// (docs/performance.md).

import { type ComponentProps, lazy } from "react";

import type { RegisterList } from "./register-list.tsx";

const List = lazy(() => import("./register-list.tsx").then((m) => ({ default: m.RegisterList })));

export function LazyRegisterList(props: ComponentProps<typeof RegisterList>) {
  return <List {...props} />;
}
