// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the announcements' tables (P2.3), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const ANNOUNCEMENT_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.announcements", column: "created_by_person_id", clubScoped: true },
  { table: "public.announcements", column: "withdrawn_by_person_id", clubScoped: true },
  {
    table: "public.announcement_reads",
    column: "person_id",
    clubScoped: true,
    // Read marks: where the kept person read it too, the duplicate's stay behind.
    open: { where: "true", key: ["announcement_id"], end: null, restore: [] },
  },
];
