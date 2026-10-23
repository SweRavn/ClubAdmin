// SPDX-License-Identifier: AGPL-3.0-only
// Only official test numbers: Skatteverket's testpersonnummer (SE) and
// synthetic Tenor test numbers from Skatteetaten (NO, month + 80).
import { describe, expect, it } from "vitest";

import {
  ageOn,
  getCountryPack,
  isSupportedCountry,
  NO,
  SE,
  UnsupportedCountryError,
} from "./index.ts";

const TODAY = new Date("2026-06-15T12:00:00Z");

describe("SE personnummer", () => {
  const { personalIdFormat: f } = SE;

  it("parses and normalises the accepted formats", () => {
    for (const input of ["193512208194", "19351220-8194", "351220-8194", " 351220 8194 "]) {
      expect(f.parse(input, TODAY)).toEqual({
        normalized: "193512208194",
        birthDate: "1935-12-20",
        kind: "birth_number",
      });
    }
    expect(f.normalize("800102-2386", TODAY)).toBe("198001022386");
  });

  it("uses the + separator for people aged 100 or more", () => {
    expect(f.normalize("900101-9802", TODAY)).toBe("199001019802");
    expect(f.normalize("900101+9802", TODAY)).toBe("189001019802");
    expect(f.normalize("18900101-9802", TODAY)).toBe("189001019802");
  });

  it("recognises samordningsnummer (day + 60)", () => {
    // Derived from the test number 800102-2386: day + 60, check digit recomputed.
    const parsed = f.parse("800162-2383", TODAY);
    expect(parsed?.kind).toBe("coordination_number");
    expect(parsed?.birthDate).toBe("1980-01-02");
  });

  it("rejects bad checksums, dates and shapes", () => {
    expect(f.isValid("193512208195", TODAY)).toBe(false);
    expect(f.isValid("19351320-8194", TODAY)).toBe(false);
    expect(f.isValid("abc", TODAY)).toBe(false);
    expect(f.isValid("19351220+8194", TODAY)).toBe(false);
    expect(f.normalize("", TODAY)).toBeNull();
  });
});

describe("NO fødselsnummer", () => {
  const { personalIdFormat: f } = NO;

  it("parses synthetic Tenor test numbers (month + 80)", () => {
    expect(f.parse("01811450010", TODAY)).toEqual({
      normalized: "01811450010",
      birthDate: "2014-01-01",
      kind: "test_number",
    });
    expect(f.parse("15817900078", TODAY)?.birthDate).toBe("1979-01-15");
  });

  it("rejects bad check digits and impossible dates", () => {
    expect(f.isValid("01811450011", TODAY)).toBe(false);
    expect(f.isValid("0181145001", TODAY)).toBe(false);
    expect(f.isValid("32811450010", TODAY)).toBe(false);
  });
});

describe("packs", () => {
  it("provide age rules and locale defaults", () => {
    expect(SE.ageRules).toEqual({ consentAge: 13, ownAccountMinAge: 13, adultAge: 18 });
    expect(NO.localeDefaults).toEqual({
      locale: "nb-NO",
      timeZone: "Europe/Oslo",
      currency: "NOK",
    });
    expect(getCountryPack("se")).toBe(SE);
    expect(isSupportedCountry("DK")).toBe(false);
    expect(() => getCountryPack("DK")).toThrow(UnsupportedCountryError);
  });

  it("computes ages", () => {
    expect(ageOn("2013-06-15", TODAY)).toBe(13);
    expect(ageOn("2013-06-16", TODAY)).toBe(12);
    expect(ageOn("2008-02-29", new Date("2026-02-28T00:00:00Z"))).toBe(17);
  });
});

describe("public holidays (P1.4)", () => {
  it("computes Easter-based and floating Swedish holidays", () => {
    const se = getCountryPack("SE").publicHolidays(2025);
    expect(se).toEqual(
      expect.arrayContaining([
        "2025-04-18", // Långfredagen
        "2025-04-20", // Påskdagen
        "2025-04-21", // Annandag påsk
        "2025-05-29", // Kristi himmelsfärdsdag
        "2025-06-08", // Pingstdagen
        "2025-06-20", // Midsommarafton
        "2025-06-21", // Midsommardagen
        "2025-11-01", // Alla helgons dag
        "2025-12-24",
      ]),
    );
    expect(getCountryPack("SE").publicHolidays(2026)).toEqual(
      expect.arrayContaining([
        "2026-04-03",
        "2026-04-05",
        "2026-06-19",
        "2026-06-20",
        "2026-10-31",
      ]),
    );
  });

  it("computes the Norwegian ones", () => {
    expect(getCountryPack("NO").publicHolidays(2025)).toEqual([
      "2025-01-01",
      "2025-04-17",
      "2025-04-18",
      "2025-04-20",
      "2025-04-21",
      "2025-05-01",
      "2025-05-17",
      "2025-05-29",
      "2025-06-08",
      "2025-06-09",
      "2025-12-25",
      "2025-12-26",
    ]);
  });
});

describe("grant rules (P1.5)", () => {
  const session = {
    date: "2026-09-15",
    durationMinutes: 90,
    participantBirthDates: ["2017-03-01", "2016-12-31", "2001-01-01"],
    leaderBirthDates: ["2013-11-30"],
  };

  it("SE: a session of 45 minutes with three participants aged 7–25 and a leader of 13 counts", () => {
    expect(SE.grantRules?.scheme).toBe("lok");
    expect(SE.grantRules?.check(session)).toEqual([]);
    expect(SE.grantRules?.check({ ...session, durationMinutes: 45 })).toEqual([]);
  });

  it("SE: names each rule a session does not meet", () => {
    expect(SE.grantRules?.check({ ...session, durationMinutes: 44 })).toEqual(["too_short"]);
    // Ages by calendar year: 2020 turns 6 in 2026, 2000 turns 26; unknown birth dates never count.
    expect(
      SE.grantRules?.check({
        ...session,
        participantBirthDates: ["2017-03-01", "2020-01-01", "2000-12-31", null],
      }),
    ).toEqual(["too_few_participants"]);
    expect(SE.grantRules?.check({ ...session, leaderBirthDates: ["2014-01-01", null] })).toEqual([
      "no_leader",
    ]);
    expect(SE.grantRules?.check({ ...session, leaderBirthDates: [] })).toEqual(["no_leader"]);
  });

  it("NO has no per-session rules", () => {
    expect(NO.grantRules).toBeNull();
  });
});
