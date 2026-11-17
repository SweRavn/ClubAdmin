// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the car pools' tables (P2.5), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const CARPOOL_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.carpool_offers", column: "driver_person_id", clubScoped: true },
  {
    table: "public.carpool_bookings",
    column: "passenger_person_id",
    clubScoped: true,
    // Where the kept person has a seat in the same car too, the duplicate's is cancelled.
    open: {
      where: "{a}.status <> 'cancelled'",
      key: ["offer_id"],
      end: { status: "'cancelled'", cancelled_at: "now()" },
      restore: ["status", "cancelled_at"],
    },
  },
  { table: "public.carpool_bookings", column: "booked_by_person_id", clubScoped: true },
  { table: "public.carpool_bookings", column: "confirmed_by_person_id", clubScoped: true },
];
