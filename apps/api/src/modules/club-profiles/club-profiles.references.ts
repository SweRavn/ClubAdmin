// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const CLUB_PROFILE_PERSON_REFERENCES: readonly PersonReference[] = [
  // One profile per club and person: if the kept person has one, the duplicate's stays.
  {
    table: "public.club_profiles",
    column: "person_id",
    clubScoped: true,
    open: { where: "true", key: ["club_id"], end: null, restore: [] },
  },
];
