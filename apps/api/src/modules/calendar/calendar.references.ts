// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
// The feeds of the merged person move to the kept one; `person_ids` (whose
// activities a feed shows) is not moved: a fetch shows only the people the
// owner still sees, so a merged ward drops out until the owner picks again.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const CALENDAR_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.calendar_feeds", column: "person_id", clubScoped: false },
];
