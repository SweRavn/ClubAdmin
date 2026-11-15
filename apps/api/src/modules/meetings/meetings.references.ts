// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the meetings' and tasks' tables (P2.4 part B), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const MEETING_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.agenda_templates", column: "created_by_person_id", clubScoped: true },
  { table: "public.meeting_agenda_items", column: "presenter_person_id", clubScoped: true },
  { table: "public.meeting_minutes", column: "assembled_by_person_id", clubScoped: true },
  { table: "public.tasks", column: "created_by_person_id", clubScoped: true },
  {
    table: "public.task_assignments",
    column: "person_id",
    clubScoped: true,
    // Where the kept person is assigned the same task too, the duplicate's assignment stays behind.
    open: { where: "true", key: ["task_id"], end: null, restore: [] },
  },
  { table: "public.task_assignments", column: "counts_for_person_id", clubScoped: true },
  { table: "public.task_assignments", column: "marked_by_person_id", clubScoped: true },
];
