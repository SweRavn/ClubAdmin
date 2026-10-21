// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const GUARDIANSHIP_PERSON_REFERENCES: readonly PersonReference[] = [
  {
    table: "public.guardianships",
    column: "ward_person_id",
    clubScoped: false,
    // The actor's own guardianship is what lets them see the others.
    restoreFirst: "{a}.guardian_person_id = app.current_person_id()",
    open: {
      where: "{a}.valid_to IS NULL",
      key: ["guardian_person_id"],
      end: { status: "'ended'", valid_to: "now()" },
      restore: ["status", "valid_to"],
    },
  },
  {
    table: "public.guardianships",
    column: "guardian_person_id",
    clubScoped: false,
    // The actor's own guardianship is what lets them see the others.
    restoreFirst: "{a}.guardian_person_id = app.current_person_id()",
    open: {
      where: "{a}.valid_to IS NULL",
      key: ["ward_person_id"],
      end: { status: "'ended'", valid_to: "now()" },
      restore: ["status", "valid_to"],
    },
  },
];
