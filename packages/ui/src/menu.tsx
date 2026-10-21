// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A drop-down menu. The page ships a plain button; the Radix UI menu
// (menu-radix.tsx, with Floating UI about 35 KB compressed) loads on the
// first click or key press, keeping it out of every page's initial JavaScript
// (docs/performance.md). Hovering or focusing the button starts the download.

import { lazy, Suspense, useState } from "react";

import { ChevronDown, type MenuProps, triggerClass } from "./menu-trigger.tsx";

export type { MenuItem, MenuProps } from "./menu-trigger.tsx";

const load = () => import("./menu-radix.tsx");
const RadixMenu = lazy(() => load().then((m) => ({ default: m.RadixMenu })));

export function Menu(props: MenuProps) {
  const [active, setActive] = useState(false);
  const plain = (
    <button
      type="button"
      aria-label={props.label}
      aria-haspopup="menu"
      aria-expanded={false}
      data-testid={props.testId}
      className={triggerClass}
      onPointerEnter={() => void load()}
      onFocus={() => void load()}
      onClick={() => setActive(true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive(true);
        }
      }}
    >
      {props.trigger}
      <ChevronDown />
    </button>
  );
  if (!active) return plain;
  return (
    <Suspense fallback={plain}>
      <RadixMenu {...props} />
    </Suspense>
  );
}
