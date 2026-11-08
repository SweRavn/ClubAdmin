// SPDX-License-Identifier: AGPL-3.0-only
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

import { type Catalogue, catalogues, type Locale } from "./index.ts";
import { describeRecurrence } from "./recurrence.ts";

const translator = (locale: Locale) => (key: string, values?: Record<string, string | number>) => {
  const message = key
    .split(".")
    .reduce<Catalogue | string | undefined>(
      (node, part) => (typeof node === "object" ? node[part] : undefined),
      catalogues[locale],
    );
  if (typeof message !== "string") throw new Error(`missing ${key}`);
  return String(new IntlMessageFormat(message, locale).format(values));
};
const date = (d: string) => d;

describe("describeRecurrence", () => {
  it("weekly slots, every other week, until further notice", () => {
    const input = {
      rule: { freq: "weekly" as const, interval: 2 },
      slots: [
        { weekday: 3, startTime: "18:00" },
        { weekday: 1, startTime: "17:30" },
      ],
      endsOn: null,
    };
    expect(describeRecurrence(translator("sv"), "sv", input, date)).toBe(
      "Varannan vecka på måndag 17:30 och onsdag 18:00, tills vidare",
    );
    expect(describeRecurrence(translator("en"), "en", input, date)).toBe(
      "Every other week on Monday 17:30 and Wednesday 18:00, until further notice",
    );
  });

  it("monthly by position and by day, to an end date", () => {
    const first = {
      rule: {
        freq: "monthly" as const,
        interval: 1,
        byDay: [{ weekday: 3, ordinal: 1 }],
        startTime: "10:00",
      },
      slots: [],
      endsOn: "2027-06-30",
    };
    expect(describeRecurrence(translator("sv"), "sv", first, date)).toBe(
      "Varje månad på första onsdagen kl. 10:00, till och med 2027-06-30",
    );
    expect(
      describeRecurrence(
        translator("en"),
        "en",
        {
          ...first,
          rule: { ...first.rule, byDay: [{ weekday: 5, ordinal: -1 }], interval: 3 },
        },
        date,
      ),
    ).toBe("Every 3 months on the last Friday at 10:00, through 2027-06-30");
    expect(
      describeRecurrence(
        translator("nb"),
        "nb",
        {
          rule: { freq: "monthly", interval: 1, byMonthDay: [15], startTime: "19:00" },
          slots: [],
          endsOn: null,
        },
        date,
      ),
    ).toBe("Hver måned den 15. kl. 19:00, inntil videre");
  });
});
