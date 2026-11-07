// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const GROUP_PERSON_REFERENCES: readonly PersonReference[] = [
  {
    table: "public.group_owners",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.valid_to IS NULL",
      key: ["group_id"],
      end: { valid_to: "now()" },
      restore: ["valid_to"],
    },
  },
  // The waiting list belongs to the groups module (P1.10b).
  {
    table: "public.group_waitlist_entries",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.status IN ('waiting', 'offered', 'accepted')",
      key: ["group_id"],
      end: { status: "'withdrawn'" },
      restore: ["status"],
    },
  },
];
