// SPDX-License-Identifier: AGPL-3.0-only
// A series' rule in plain language (P1.14): "Every other week on Monday
// 17:30 and Wednesday 18:00, until further notice", "Every month on the
// first Saturday at 10:00, through 30 June 2027". The web and the app both
// call it with their translator (keys under `recurrence`); weekday names come
// from Intl in the viewer's language.

export interface RecurrenceSummaryInput {
  rule: {
    freq: "daily" | "weekly" | "monthly";
    interval: number;
    byDay?: { weekday: number; ordinal: number }[] | undefined;
    byMonthDay?: number[] | undefined;
    startTime?: string | undefined;
    durationMinutes?: number | undefined;
  };
  slots: readonly { weekday: number; startTime: string }[];
  /** Null: until further notice. */
  endsOn: string | null;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Weekday name (ISO 1 = Monday) in a language. */
export function weekdayName(locale: string, weekday: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, weekday)),
  );
}

/** "a, b and c" in the viewer's language (a comma list where Intl.ListFormat is missing, e.g. Hermes). */
function list(locale: string, items: readonly string[]): string {
  if (typeof Intl.ListFormat !== "function") return items.join(", ");
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}

export function describeRecurrence(
  t: Translate,
  locale: string,
  input: RecurrenceSummaryInput,
  formatDate: (date: string) => string,
): string {
  const { rule } = input;
  const every = t(`recurrence.every.${rule.freq}`, { interval: rule.interval });
  let pattern: string;
  if (rule.freq === "weekly") {
    const slots = [...input.slots].sort((a, b) => a.weekday - b.weekday);
    pattern = t("recurrence.weekly", {
      every,
      slots: list(
        locale,
        slots.map((s) =>
          t("recurrence.slot", { weekday: weekdayName(locale, s.weekday), time: s.startTime }),
        ),
      ),
    });
  } else if (rule.freq === "monthly" && rule.byDay?.length) {
    pattern = t("recurrence.monthlyByPosition", {
      every,
      positions: list(
        locale,
        rule.byDay.map((d) =>
          t("recurrence.position", {
            ordinal: t(`recurrence.ordinal.${d.ordinal === -1 ? "last" : d.ordinal}`),
            weekday: weekdayName(locale, d.weekday),
          }),
        ),
      ),
      time: rule.startTime ?? "",
    });
  } else if (rule.freq === "monthly") {
    pattern = t("recurrence.monthlyByDay", {
      every,
      days: list(locale, (rule.byMonthDay ?? []).map(String)),
      time: rule.startTime ?? "",
    });
  } else {
    pattern = t("recurrence.daily", { every, time: rule.startTime ?? "" });
  }
  return input.endsOn === null
    ? t("recurrence.untilFurtherNotice", { pattern })
    : t("recurrence.through", { pattern, date: formatDate(input.endsOn) });
}
