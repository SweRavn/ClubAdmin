// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Copies a text (a calendar subscription's URL, P1.11). Without JavaScript or
// clipboard access the text stays selectable next to it.
import { useState } from "react";

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md border border-border px-3 py-1 text-sm"
      data-testid="copy-button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? done : label}
    </button>
  );
}
