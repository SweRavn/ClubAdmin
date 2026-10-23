// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const MEMBERS_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.member_exports", column: "requested_by_person_id", clubScoped: true },
  // Member imports (P1.3b): who started and confirmed them, and the staging
  // rows' matched and created people (deleted seven days after the import).
  { table: "public.member_imports", column: "created_by_person_id", clubScoped: true },
  { table: "public.member_imports", column: "confirmed_by_person_id", clubScoped: true },
  { table: "public.member_import_rows", column: "match_person_id", clubScoped: true },
  { table: "public.member_import_rows", column: "person_id", clubScoped: true },
];
