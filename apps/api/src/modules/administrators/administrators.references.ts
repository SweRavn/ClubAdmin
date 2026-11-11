// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const ADMINISTRATOR_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.administrator_suspensions", column: "target_person_id", clubScoped: true },
  { table: "public.administrator_suspensions", column: "requested_by_person_id", clubScoped: true },
  { table: "public.administrator_suspensions", column: "confirmed_by_person_id", clubScoped: true },
];
