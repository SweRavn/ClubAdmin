// SPDX-License-Identifier: AGPL-3.0-only
// Billing arithmetic (P1.13, ADR 0045): integer minor units only, never
// floats for money. VAT rates in basis points (2500 = 25 %), VAT per line
// rounded half away from zero, totals from the lines.

import { localDate, zonedTime } from "../domain/zoned-time.ts";

/** Rounds a ratio of integers half away from zero (credit notes are negative). */
export function roundHalfAway(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** VAT of an amount at a rate in basis points. */
export const vatOf = (amountMinor: number, rateBp: number): number =>
  roundHalfAway(amountMinor * rateBp, 10_000);

export interface DraftLine {
  descriptionKey: string;
  planId: string | null;
  quantity: number;
  unitMinor: number;
  amountMinor: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  proration: boolean;
  vatRateBp: number;
}

export interface PricedLine extends DraftLine {
  vatMinor: number;
}

export interface InvoiceTotals {
  lines: PricedLine[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  /** VAT per rate (the invoice's VAT summary). */
  vatByRate: { rateBp: number; baseMinor: number; vatMinor: number }[];
}

/** VAT per line and the totals; every total equals the sum of its lines. */
export function priceLines(lines: readonly DraftLine[]): InvoiceTotals {
  const priced = lines.map((l) => ({ ...l, vatMinor: vatOf(l.amountMinor, l.vatRateBp) }));
  const byRate = new Map<number, { baseMinor: number; vatMinor: number }>();
  for (const l of priced) {
    const r = byRate.get(l.vatRateBp) ?? { baseMinor: 0, vatMinor: 0 };
    r.baseMinor += l.amountMinor;
    r.vatMinor += l.vatMinor;
    byRate.set(l.vatRateBp, r);
  }
  const subtotalMinor = priced.reduce((s, l) => s + l.amountMinor, 0);
  const vatMinor = priced.reduce((s, l) => s + l.vatMinor, 0);
  return {
    lines: priced,
    subtotalMinor,
    vatMinor,
    totalMinor: subtotalMinor + vatMinor,
    vatByRate: [...byRate.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rateBp, r]) => ({ rateBp, ...r })),
  };
}

export type BillingPeriod = "month" | "year";

/**
 * The calendar period (month or year, in the club's time zone) that contains
 * `at`: [start, end).
 */
export function periodAt(
  at: Date,
  period: BillingPeriod,
  timeZone: string,
): { start: Date; end: Date } {
  const [y, m] = localDate(at, timeZone).split("-").map(Number) as [number, number];
  const startDate = period === "month" ? `${y}-${pad(m)}-01` : `${y}-01-01`;
  const endDate =
    period === "month" ? (m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`) : `${y + 1}-01-01`;
  return {
    start: zonedTime(startDate, "00:00", timeZone)!,
    end: zonedTime(endDate, "00:00", timeZone)!,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Whole days in [from, to) in the club's time zone (calendar days). */
export function daysBetween(from: Date, to: Date, timeZone: string): number {
  const a = Date.parse(`${localDate(from, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${localDate(to, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The prorated amount of a period's price for [from, period end). */
export function prorate(
  priceMinor: number,
  period: { start: Date; end: Date },
  from: Date,
  timeZone: string,
): number {
  const total = daysBetween(period.start, period.end, timeZone);
  const used = daysBetween(from, period.end, timeZone);
  if (used >= total) return priceMinor;
  if (used <= 0) return 0;
  return roundHalfAway(priceMinor * used, total);
}
