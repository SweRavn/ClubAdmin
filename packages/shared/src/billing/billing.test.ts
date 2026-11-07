// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  isValidLuhn,
  ocrReference,
  periodAt,
  priceLines,
  prorate,
  roundHalfAway,
  vatFor,
  vatOf,
} from "./index.ts";

const SELLER = { country: "SE", vatRateBp: 2500 };

describe("money", () => {
  it("rounds half away from zero, also for credit notes", () => {
    expect(roundHalfAway(5, 2)).toBe(3);
    expect(roundHalfAway(-5, 2)).toBe(-3);
    expect(vatOf(49_900, 2500)).toBe(12_475);
    expect(vatOf(-49_900, 2500)).toBe(-12_475);
    expect(vatOf(3, 2500)).toBe(1);
  });

  it("totals equal the sum of the lines, with VAT per rate", () => {
    const line = (amount: number, rate: number) => ({
      descriptionKey: "x",
      planId: null,
      quantity: 1,
      unitMinor: amount,
      amountMinor: amount,
      periodStart: null,
      periodEnd: null,
      proration: false,
      vatRateBp: rate,
    });
    const t = priceLines([line(49_900, 2500), line(19_900, 2500), line(1_000, 0)]);
    expect(t.subtotalMinor).toBe(70_800);
    expect(t.vatMinor).toBe(12_475 + 4_975);
    expect(t.totalMinor).toBe(t.subtotalMinor + t.vatMinor);
    expect(t.vatByRate).toEqual([
      { rateBp: 2500, baseMinor: 69_800, vatMinor: 17_450 },
      { rateBp: 0, baseMinor: 1_000, vatMinor: 0 },
    ]);
  });

  it("aligns periods to the calendar in the club's time zone and prorates by day", () => {
    const p = periodAt(new Date("2026-11-15T12:00:00Z"), "month", "Europe/Stockholm");
    expect(p.start.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-11-30T23:00:00.000Z");
    const y = periodAt(new Date("2026-11-15T12:00:00Z"), "year", "Europe/Stockholm");
    expect(y.start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    // From 16 November: 15 of 30 days.
    expect(prorate(30_000, p, new Date("2026-11-16T10:00:00Z"), "Europe/Stockholm")).toBe(15_000);
    expect(prorate(30_000, p, p.start, "Europe/Stockholm")).toBe(30_000);
  });
});

describe("VAT", () => {
  it("charges Swedish VAT to Swedish clubs", () => {
    expect(vatFor(SELLER, { country: "SE", vatNumber: null })).toEqual({
      rateBp: 2500,
      note: "none",
    });
  });
  it("reverse-charges EU buyers with a VAT number", () => {
    expect(vatFor(SELLER, { country: "FI", vatNumber: "FI12345678" })).toEqual({
      rateBp: 0,
      note: "reverse_charge",
    });
  });
  it("charges Swedish VAT to EU buyers without a VAT number", () => {
    expect(vatFor(SELLER, { country: "DK", vatNumber: null })).toEqual({
      rateBp: 2500,
      note: "none",
    });
  });
  it("leaves buyers outside the EU outside the scope of Swedish VAT", () => {
    expect(vatFor(SELLER, { country: "NO", vatNumber: null })).toEqual({
      rateBp: 0,
      note: "outside_scope",
    });
  });
});

describe("OCR", () => {
  it("builds references with a length and a Luhn check digit", () => {
    const ref = ocrReference("CA-000123");
    // Digits 000123, length digit 8 (six digits + two), then the check digit.
    expect(ref.slice(0, 7)).toBe("0001238");
    expect(isValidLuhn(ref)).toBe(true);
    expect(isValidLuhn(`${ref.slice(0, -1)}${(Number(ref.at(-1)) + 1) % 10}`)).toBe(false);
  });
});
