// SPDX-License-Identifier: AGPL-3.0-only
// What the plain button (menu.tsx) and the Radix menu (menu-radix.tsx)
// share: the props and the trigger's look.

import type { ReactNode } from "react";

export type MenuItem =
  | { kind: "link"; key: string; label: string; href: string; current?: boolean }
  | { kind: "submit"; key: string; label: string; form: string; name?: string; value?: string }
  | { kind: "separator"; key: string };

export interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  testId?: string;
}

export const triggerClass =
  "inline-flex max-w-56 items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface";

export function ChevronDown() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M5 7l5 6 5-6z" />
    </svg>
  );
}
