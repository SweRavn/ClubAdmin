// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Search as you type (P2.7b, generalised from the register's search): after
// a short pause, from two characters, the GET form's values replace those in
// the URL's query and the server renders the matches under the field (a new
// search supersedes the previous one). Arrow down moves into the matches,
// Escape clears the field. Without JavaScript the form's own submit button
// (SubmitWithoutScript) searches as before. Searches are by the API's
// keyset-limited, indexed queries; the query is the same as with the button.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

const DELAY_MS = 250;

export function LiveSearch({
  name,
  defaultValue,
  label,
  placeholder,
  resultsId,
  testId,
  className,
  minLength = 2,
}: {
  name: string;
  defaultValue: string;
  /** The accessible name (also the placeholder when none is given). */
  label: string;
  placeholder?: string;
  /** The element with the matches (the arrow keys move into it). */
  resultsId: string;
  testId?: string;
  className?: string;
  minLength?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = (form: HTMLFormElement | null) => {
    if (!form) return;
    const params = new URLSearchParams(current.toString());
    const data = new FormData(form);
    for (const key of new Set(data.keys())) params.delete(key);
    for (const [key, value] of data) {
      if (typeof value !== "string") continue;
      if (key === name && value.trim().length < minLength) continue;
      if (value.trim() !== "") params.append(key, value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return (
    <input
      type="search"
      name={name}
      defaultValue={defaultValue}
      maxLength={100}
      autoComplete="off"
      role="combobox"
      aria-label={label}
      aria-controls={resultsId}
      aria-expanded={defaultValue.trim().length >= minLength}
      aria-autocomplete="list"
      placeholder={placeholder ?? label}
      data-testid={testId}
      className={className}
      onInput={(event) => {
        const form = event.currentTarget.form;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => search(form), DELAY_MS);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          const first = document
            .getElementById(resultsId)
            ?.querySelector<HTMLElement>("button, a, input:not([type=hidden])");
          if (first) {
            event.preventDefault();
            first.focus();
          }
        } else if (event.key === "Escape") {
          event.currentTarget.value = "";
          search(event.currentTarget.form);
        }
      }}
    />
  );
}

/** The form's submit button, only without JavaScript (with it, the search runs as one types). */
export function SubmitWithoutScript({ children }: { children: ReactNode }) {
  const [scripted, setScripted] = useState(false);
  useEffect(() => setScripted(true), []);
  return scripted ? null : <>{children}</>;
}
