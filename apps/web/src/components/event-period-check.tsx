// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The event form's period check in the browser (P1.6b): the end must be
// after the start and the sign-up deadline not after the end. Shows the
// message where it is placed and disables the form's save buttons; the API
// checks the same (event_period_invalid). Local times in the club's time
// zone compare as text ("2026-11-20T09:00").

import { useEffect, useRef, useState } from "react";

const value = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";

/** The local moment of a date and time field; a missing time is the start or end of the day. */
function moment(form: HTMLFormElement, prefix: string, endOfDay: boolean): string | null {
  const date = value(form, `${prefix}Date`);
  if (!date) return null;
  return `${date}T${value(form, `${prefix}Time`) || (endOfDay ? "23:59" : "00:00")}`;
}

export function EventPeriodCheck({
  texts,
}: {
  texts: { endBeforeStart: string; closesAfterEnd: string };
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const check = () => {
      const start = moment(form, "start", false);
      const end = moment(form, "end", true) ?? (start ? `${start.slice(0, 10)}T23:59` : null);
      const closes = moment(form, "closes", true);
      const problem =
        start && end && end <= start
          ? texts.endBeforeStart
          : closes && end && closes > end
            ? texts.closesAfterEnd
            : null;
      setMessage(problem);
      for (const button of form.querySelectorAll<HTMLButtonElement>("button[type=submit]")) {
        if (button.name !== "more") button.disabled = problem !== null;
      }
    };
    check();
    form.addEventListener("input", check);
    return () => form.removeEventListener("input", check);
  }, [texts]);
  return (
    <p
      ref={ref}
      role="alert"
      hidden={message === null}
      className="text-sm text-danger sm:col-span-2"
      data-testid="event-period-error"
    >
      {message}
    </p>
  );
}
