// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { aloneChild, type CarFacts, type SeatState, settleSeats } from "./rule-of-two.ts";

const DRIVER = "driver";
const CHILDREN = new Set(["kid", "kid2", "own"]);
const GUARDIANS: Record<string, string[]> = { kid: ["parent"], kid2: ["parent2"], own: [DRIVER] };

const seat = (passenger: string, extra: Partial<SeatState> = {}): SeatState => ({
  bookingId: `b-${passenger}`,
  passengerPersonId: passenger,
  status: "held",
  confirmedByPersonId: null,
  ...extra,
});

const car = (seats: SeatState[], driver = DRIVER): CarFacts => ({
  driverPersonId: driver,
  seats,
  isChild: (p) => CHILDREN.has(p),
  guardiansOf: (p) => GUARDIANS[p] ?? [],
});

describe("the rule of two", () => {
  it("one adult and a single child not their own: the seat waits", () => {
    expect(aloneChild(car([seat("kid")]))).toBe("kid");
    expect(settleSeats(car([seat("kid")]))).toEqual([
      { bookingId: "b-kid", status: "pending_guardian", confirmedBy: null, newlyPending: true },
    ]);
  });

  it("whoever drives: a leader or another child's parent alike", () => {
    expect(aloneChild(car([seat("kid")], "coach"))).toBe("kid");
    expect(aloneChild(car([seat("kid")], "parent2"))).toBe("kid");
  });

  it("the driver's own child alone in the car needs nothing", () => {
    expect(aloneChild(car([seat("own")]))).toBeNull();
    expect(settleSeats(car([seat("own")]))).toEqual([]);
  });

  it("the driver's own child with another child: two children, nothing to confirm", () => {
    expect(aloneChild(car([seat("own"), seat("kid")]))).toBeNull();
  });

  it("a second adult in the car makes it unnecessary", () => {
    expect(aloneChild(car([seat("kid"), seat("adult")]))).toBeNull();
  });

  it("two children not the driver's own: nothing to confirm", () => {
    expect(aloneChild(car([seat("kid"), seat("kid2")]))).toBeNull();
  });

  it("an adult passenger alone with the driver: nothing", () => {
    expect(aloneChild(car([seat("adult")]))).toBeNull();
  });

  it("a guardian's confirmation holds the seat", () => {
    const pending = seat("kid", { status: "pending_guardian" });
    expect(settleSeats(car([pending]), { bookingId: "b-kid", byPersonId: "parent" })).toEqual([
      { bookingId: "b-kid", status: "held", confirmedBy: "parent", newlyPending: false },
    ]);
    const confirmed = seat("kid", { confirmedByPersonId: "parent" });
    expect(settleSeats(car([confirmed]))).toEqual([]);
  });

  it("when the situation ends, pending seats are held and confirmations go", () => {
    const pending = seat("kid", { status: "pending_guardian" });
    expect(settleSeats(car([pending, seat("kid2")]))).toEqual([
      { bookingId: "b-kid", status: "held", confirmedBy: null, newlyPending: false },
    ]);
    const confirmed = seat("kid", { confirmedByPersonId: "parent" });
    expect(settleSeats(car([confirmed, seat("adult")]))).toEqual([
      { bookingId: "b-kid", status: "held", confirmedBy: null, newlyPending: false },
    ]);
  });

  it("a change that creates the situation again asks again", () => {
    // kid2 cancelled: kid is alone again, with no confirmation left.
    expect(settleSeats(car([seat("kid")]))[0]).toMatchObject({
      status: "pending_guardian",
      newlyPending: true,
    });
  });
});
