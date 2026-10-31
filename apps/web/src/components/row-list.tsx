// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A list of form rows rendered by the server (P1.6b): the first `initial`
// are shown; "Add" shows the next one, "Remove" hides a row and disables its
// fields (a disabled fieldset is not submitted). Without JavaScript the
// hidden rows stay disabled and the page's own "Add" submit button (in
// `fallback`) brings the form back with one more row.

import { type ReactNode, useEffect, useState } from "react";

export function RowList({
  rows,
  initial,
  countName,
  texts,
  fallback,
  testId,
}: {
  rows: readonly ReactNode[];
  initial: number;
  /** The hidden field with the number of rows shown (for the fallback). */
  countName: string;
  texts: { add: string; remove: string };
  fallback: ReactNode;
  testId?: string;
}) {
  const [scripted, setScripted] = useState(false);
  const [shown, setShown] = useState(() => Math.min(Math.max(initial, 1), rows.length));
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setScripted(true), []);
  const visible = (i: number) => i < shown && !removed.has(i);
  return (
    <div className="space-y-3" data-testid={testId}>
      <input type="hidden" name={countName} value={shown} />
      {rows.map((row, i) => (
        <fieldset
          key={i}
          disabled={!visible(i)}
          hidden={!visible(i)}
          className="relative"
          data-testid={testId ? `${testId}-row` : undefined}
        >
          {row}
          {scripted ? (
            <button
              type="button"
              className="mt-1 text-sm underline"
              onClick={() => setRemoved(new Set([...removed, i]))}
              data-testid={testId ? `${testId}-remove` : undefined}
            >
              {texts.remove}
            </button>
          ) : null}
        </fieldset>
      ))}
      {scripted ? (
        shown < rows.length ? (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface"
            onClick={() => setShown(shown + 1)}
            data-testid={testId ? `${testId}-add` : undefined}
          >
            {texts.add}
          </button>
        ) : null
      ) : (
        fallback
      )}
    </div>
  );
}
