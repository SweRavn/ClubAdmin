// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the plugin tables (P2.7), for merging duplicate
// people: a background check or request moves to the person kept.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const PLUGIN_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.background_checks", column: "person_id", clubScoped: true },
  { table: "public.background_checks", column: "verified_by_person_id", clubScoped: true },
  { table: "public.background_check_requests", column: "person_id", clubScoped: true },
  { table: "public.background_check_requests", column: "requested_by_person_id", clubScoped: true },
  { table: "public.grant_reports", column: "locked_by_person_id", clubScoped: true },
];
