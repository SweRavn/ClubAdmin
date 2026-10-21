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
