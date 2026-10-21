// SPDX-License-Identifier: AGPL-3.0-only
// @clubadmin/ui: shared web UI primitives (P0.9). Design tokens are in
// tokens.css (imported by the app's stylesheet). Components take translated
// labels as props; they contain no user-facing text of their own. DataList
// (with TanStack Query) is imported from "@clubadmin/ui/data-list", so pages
// without a list do not load it.

export { ClubSwitcher, type ClubSwitcherProps } from "./club-switcher.tsx";
export {
  DateTime,
  type DateTimeFormatOptions,
  type DateTimeProps,
  formatDateTime,
  sameOffset,
  zoneName,
} from "./date-time.tsx";
export { EmptyState, type EmptyStateProps, Skeleton } from "./empty-state.tsx";
export { Menu, type MenuItem, type MenuProps } from "./menu.tsx";
export { personLabel, PersonName, type PersonNameProps } from "./person-name.tsx";
export { ProtectedBadge, type ProtectedBadgeProps } from "./protected-badge.tsx";
export { RoleBadge, type RoleBadgeProps } from "./role-badge.tsx";
