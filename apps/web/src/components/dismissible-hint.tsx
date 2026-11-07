// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A hint the viewer can hide on this device (P1.12: "protect yourself too").
// Without JavaScript or storage it simply stays visible.
import { type ReactNode, useEffect, useState } from "react";

export function DismissibleHint({
  storageKey,
  hideLabel,
  children,
}: {
  storageKey: string;
  hideLabel: string;
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(storageKey) === "1");
    } catch {
      // Storage blocked: keep showing it.
    }
  }, [storageKey]);
  if (hidden) return null;
  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-md border border-protected bg-protected-soft p-3"
      data-testid="protect-yourself-hint"
    >
      <div className="flex-1 space-y-2">{children}</div>
      <button
        type="button"
        className="text-sm underline"
        onClick={() => {
          try {
            window.localStorage.setItem(storageKey, "1");
          } catch {
            // Storage blocked: hide for now.
          }
          setHidden(true);
        }}
      >
        {hideLabel}
      </button>
    </div>
  );
}
