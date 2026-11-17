// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the expense claims (P2.5 part B), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const EXPENSE_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.expense_claims", column: "claimant_person_id", clubScoped: true },
  { table: "public.expense_claims", column: "routed_to_person_id", clubScoped: true },
  { table: "public.expense_claims", column: "decided_by_person_id", clubScoped: true },
];
