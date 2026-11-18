// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the duties' own tables (P2.6), for merging duplicate
// people; the shifts' assignments are the meetings module's task references.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const DUTY_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.task_swaps", column: "created_by_person_id", clubScoped: true },
  { table: "public.task_swaps", column: "taker_person_id", clubScoped: true },
  { table: "public.task_swaps", column: "taker_counts_for_person_id", clubScoped: true },
  { table: "public.duty_unavailability", column: "person_id", clubScoped: true },
];
