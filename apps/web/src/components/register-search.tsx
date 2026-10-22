// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Search as you type in the member register (P1.2): after a short pause the
// form's values replace the URL's query, and the server renders the matches.
// Without JavaScript the form's submit button does the same.

import { usePathname, useRouter } from "next/navigation";
import { useRef } from "react";

const DELAY_MS = 250;

export function RegisterSearch({
  name,
  defaultValue,
  label,
}: {
  name: string;
  defaultValue: string;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        maxLength={100}
        autoComplete="off"
        data-testid="register-search"
        className="w-full rounded-md border border-border bg-bg px-3 py-2"
        onInput={(event) => {
          const form = event.currentTarget.form;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            if (!form) return;
            const params = new URLSearchParams();
            for (const [key, value] of new FormData(form)) {
              if (typeof value === "string" && value.trim() !== "") params.append(key, value);
            }
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
          }, DELAY_MS);
        }}
      />
    </label>
  );
}
