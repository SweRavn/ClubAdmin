// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the file archive's tables (P2.2), for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const DOCUMENT_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.document_folders", column: "created_by_person_id", clubScoped: true },
  { table: "public.document_folders", column: "deleted_by_person_id", clubScoped: true },
  { table: "public.documents", column: "created_by_person_id", clubScoped: true },
  { table: "public.documents", column: "deleted_by_person_id", clubScoped: true },
  { table: "public.document_versions", column: "uploaded_by_person_id", clubScoped: true },
];
