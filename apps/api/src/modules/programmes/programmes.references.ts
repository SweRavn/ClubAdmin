// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the programmes' own tables (P2.9), for merging
// duplicate people: only who created a template or a programme.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const PROGRAMME_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.programme_templates", column: "created_by_person_id", clubScoped: true },
  { table: "public.programmes", column: "created_by_person_id", clubScoped: true },
];
