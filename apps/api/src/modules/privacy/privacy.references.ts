// SPDX-License-Identifier: AGPL-3.0-only
// Person references of the privacy module's tables (P1.8a), for merging
// duplicate people. Consents themselves are covered with the memberships
// (JOINING_PERSON_REFERENCES); who gave, revoked, published or recorded
// something is moved as plain references.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const PRIVACY_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.consents", column: "given_by_person_id", clubScoped: true },
  { table: "public.consents", column: "revoked_by_person_id", clubScoped: true },
  { table: "public.consent_texts", column: "published_by_person_id", clubScoped: true },
  { table: "public.club_setting_decisions", column: "recorded_by_person_id", clubScoped: true },
];
