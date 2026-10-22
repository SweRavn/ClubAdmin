// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const MEMBER_EXPORT_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.member_exports", column: "requested_by_person_id", clubScoped: true },
];
