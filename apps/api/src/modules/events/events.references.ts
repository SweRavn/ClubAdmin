// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const EVENT_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.events", column: "created_by_person_id", clubScoped: true },
  {
    table: "public.event_registrations",
    column: "person_id",
    clubScoped: true,
    // One open registration per event: the duplicate's ends when both had one.
    open: {
      where: "{a}.status IN ('confirmed', 'waitlisted', 'offered')",
      key: ["event_id"],
      end: { status: "'cancelled'", offer_expires_at: "NULL" },
      restore: ["status", "offer_expires_at"],
    },
  },
  { table: "public.event_registrations", column: "registered_by_person_id", clubScoped: true },
  { table: "public.event_registrations", column: "decided_by_person_id", clubScoped: true },
];
