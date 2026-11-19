// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Arrow keys in the role matrix (P2.7c): move between the cells' buttons
// (left, right, up, down); Space and Enter toggle the focused cell (the
// button's own behaviour). Without JavaScript Tab moves through them.
import type { ReactNode } from "react";

export function RoleMatrixKeys({ children }: { children: ReactNode }) {
  return (
    <div
      onKeyDown={(event) => {
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [0, -1],
          ArrowRight: [0, 1],
          ArrowUp: [-1, 0],
          ArrowDown: [1, 0],
        };
        const move = moves[event.key];
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
        if (!move || !cell) return;
        const [row, col] = (cell.dataset.cell ?? "").split(":").map(Number) as [number, number];
        const next = event.currentTarget.querySelector<HTMLElement>(
          `[data-cell="${row + move[0]}:${col + move[1]}"]`,
        );
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
