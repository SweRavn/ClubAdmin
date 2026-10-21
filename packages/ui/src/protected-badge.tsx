// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The crossed-camera icon for people with protected identity (ADR 0022),
// with the tooltip "Protected identity — do not photograph, film or share".
// The tooltip shows on hover and keyboard focus and closes with Escape
// (WCAG 1.4.13); screen readers get the same text as the button's name.
// Deliberately without a positioning library: it is on every roster.

import { useId, useState } from "react";

export interface ProtectedBadgeProps {
  /** The translated tooltip text. */
  label: string;
}

export function ProtectedBadge({ label }: ProtectedBadgeProps) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span className="group relative inline-flex" onPointerLeave={() => setDismissed(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        data-testid="protected-badge"
        onKeyDown={(event) => {
          if (event.key === "Escape") setDismissed(true);
        }}
        onBlur={() => setDismissed(false)}
        className="inline-flex size-6 items-center justify-center rounded-sm bg-protected-soft align-middle text-protected"
      >
        <CrossedCamera />
      </button>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden w-max max-w-64 -translate-x-1/2 rounded-md bg-fg px-2 py-1 text-sm text-bg shadow ${
          dismissed ? "" : "group-hover:block group-focus-within:block"
        }`}
      >
        {label}
      </span>
    </span>
  );
}

function CrossedCamera() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8M9.5 10.5a3.5 3.5 0 0 0 4.9 4.9M3 3l18 18"
      />
    </svg>
  );
}
