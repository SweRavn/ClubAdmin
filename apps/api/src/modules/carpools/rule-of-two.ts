// SPDX-License-Identifier: AGPL-3.0-only
// The rule of two in a car (P2.5, ADR 0048 decision 4), a pure function.
//
// The situation: the driver, no other adult, and exactly one child, who is
// not the driver's own (any active guardianship of the driver). Then that
// child's seat waits for a guardian's active confirmation, whoever drives.
// A second adult or the driver's own child in the car makes it unnecessary.
// A confirmation holds only while the situation lasts: when it ends the
// confirmation goes, so a change that creates it again asks again.

export interface SeatState {
  bookingId: string;
  passengerPersonId: string;
  status: "held" | "pending_guardian";
  confirmedByPersonId: string | null;
}

export interface CarFacts {
  driverPersonId: string;
  seats: readonly SeatState[];
  /** Whether the person is a child (below the adult age; unknown age with a guardian). */
  isChild: (personId: string) => boolean;
  /** The person's active guardians. */
  guardiansOf: (personId: string) => readonly string[];
}

export interface SeatChange {
  bookingId: string;
  status: "held" | "pending_guardian";
  confirmedBy: string | null;
  /** The seat now waits for a confirmation it did not wait for before. */
  newlyPending: boolean;
}

/** The single child alone with an adult not their guardian, or null. */
export function aloneChild(car: CarFacts): string | null {
  const passengers = car.seats.map((s) => s.passengerPersonId);
  if (passengers.some((p) => !car.isChild(p))) return null;
  if (passengers.length !== 1) return null;
  const child = passengers[0]!;
  return car.guardiansOf(child).includes(car.driverPersonId) ? null : child;
}

/**
 * The seats' states the rule asks for. `confirm`: a guardian confirms this
 * seat now (they saw the driver's name). Returns only the seats that change.
 */
export function settleSeats(
  car: CarFacts,
  confirm?: { bookingId: string; byPersonId: string },
): SeatChange[] {
  const child = aloneChild(car);
  const changes: SeatChange[] = [];
  for (const seat of car.seats) {
    let next: { status: "held" | "pending_guardian"; confirmedBy: string | null };
    if (seat.passengerPersonId === child) {
      const confirmedBy =
        confirm?.bookingId === seat.bookingId ? confirm.byPersonId : seat.confirmedByPersonId;
      next = confirmedBy
        ? { status: "held", confirmedBy }
        : { status: "pending_guardian", confirmedBy: null };
    } else {
      next = { status: "held", confirmedBy: null };
    }
    if (next.status !== seat.status || next.confirmedBy !== seat.confirmedByPersonId) {
      changes.push({
        bookingId: seat.bookingId,
        ...next,
        newlyPending: next.status === "pending_guardian" && seat.status !== "pending_guardian",
      });
    }
  }
  return changes;
}
