// SPDX-License-Identifier: AGPL-3.0-only
// Relative times of the demo data ("-6y", "-14mo", "+3d", "now"), resolved
// against the day of seeding, and birth dates that keep ages correct.

import type { RelativeTime } from "@clubadmin/shared";

export class SeedClock {
  /** The moment the seed runs; every relative time is resolved against it. */
  readonly now: Date;

  constructor(now: Date = new Date()) {
    this.now = now;
  }

  at(time: RelativeTime): Date {
    if (time === "now") return new Date(this.now);
    const match = /^([+-])(\d+)(y|mo|d)$/.exec(time);
    if (!match) throw new Error(`invalid relative time ${time}`);
    const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    const date = new Date(this.now);
    if (match[3] === "y") date.setUTCFullYear(date.getUTCFullYear() + amount);
    else if (match[3] === "mo") date.setUTCMonth(date.getUTCMonth() + amount);
    else date.setUTCDate(date.getUTCDate() + amount);
    return date;
  }

  /** The past moment, or undefined for "now" (no time travel). */
  past(time: RelativeTime | null | undefined): Date | undefined {
    return time && time !== "now" ? this.at(time) : undefined;
  }

  /** A calendar date (YYYY-MM-DD) relative to today. */
  day(time: RelativeTime): string {
    return this.at(time).toISOString().slice(0, 10);
  }

  /** Birth date (YYYY-MM-DD) for someone who is `age` today and has their birthday on MM-DD. */
  birthDate(age: number, birthday: string): string {
    const today = this.now.toISOString().slice(5, 10);
    const year = this.now.getUTCFullYear() - age - (birthday > today ? 1 : 0);
    // 29 February in a non-leap year becomes 28 February.
    const [month, day] = birthday.split("-").map(Number) as [number, number];
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const safeDay = month === 2 && day === 29 && !leap ? 28 : day;
    return `${year}-${String(month).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
  }

  /** The year `yearsAgo` years before the year of seeding. */
  year(yearsAgo: number): number {
    return this.now.getUTCFullYear() - yearsAgo;
  }
}
