// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A hint the viewer can hide on this device (P1.12: "protect yourself too"),
// for good or for `days` (P1.15 A3: the third administrator, 90 days).
// Without JavaScript or storage it simply stays visible.
import { type ReactNode, useEffect, useState } from "react";

export function DismissibleHint({
  storageKey,
  hideLabel,
  days,
  testId = "protect-yourself-hint",
  tone = "protected",
  children,
}: {
  storageKey: string;
  hideLabel: string;
  /** Hidden for this many days; without it, for good. */
  days?: number;
  testId?: string;
  tone?: "protected" | "info";
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      const value = window.localStorage.getItem(storageKey);
      // "1": hidden for good; a number: hidden until that time.
      setHidden(value === "1" || (value !== null && Number(value) > Date.now()));
    } catch {
      // Storage blocked: keep showing it.
    }
  }, [storageKey]);
  if (hidden) return null;
  const colours =
    tone === "info" ? "border-border bg-accent-soft" : "border-protected bg-protected-soft";
  return (
    <div
      className={`flex flex-wrap items-start gap-3 rounded-md border p-3 ${colours}`}
      data-testid={testId}
    >
      <div className="flex-1 space-y-2">{children}</div>
      <button
        type="button"
        className="text-sm underline"
        onClick={() => {
          try {
            window.localStorage.setItem(
              storageKey,
              days ? String(Date.now() + days * 86_400_000) : "1",
            );
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
