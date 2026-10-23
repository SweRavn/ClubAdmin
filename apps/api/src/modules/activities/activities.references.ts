// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const ACTIVITY_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.activity_series", column: "created_by_person_id", clubScoped: true },
  { table: "public.activities", column: "created_by_person_id", clubScoped: true },
];
