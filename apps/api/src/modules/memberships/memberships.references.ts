// SPDX-License-Identifier: AGPL-3.0-only
// Person references of this module's tables, for merging duplicate people.
import type { PersonReference } from "../../platform/domain/person-references.ts";

export const MEMBERSHIP_PERSON_REFERENCES: readonly PersonReference[] = [
  {
    table: "public.club_memberships",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.valid_to IS NULL",
      key: ["club_id"],
      end: { status: "'left'", valid_to: "now()" },
      restore: ["status", "valid_to"],
    },
  },
  {
    table: "public.group_memberships",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.valid_to IS NULL",
      key: ["group_id", "function"],
      end: { valid_to: "now()" },
      restore: ["valid_to"],
    },
  },
];

/** Club-owned tables without their own module yet (schema only in P0.5). */
export const JOINING_PERSON_REFERENCES: readonly PersonReference[] = [
  { table: "public.employments", column: "person_id", clubScoped: true },
  {
    table: "public.consents",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.revoked_at IS NULL",
      key: ["purpose"],
      end: { revoked_at: "now()" },
      restore: ["revoked_at"],
    },
  },
  {
    table: "public.group_waitlist_entries",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.status IN ('waiting', 'offered')",
      key: ["group_id"],
      end: { status: "'withdrawn'" },
      restore: ["status"],
    },
  },
  {
    table: "public.join_requests",
    column: "person_id",
    clubScoped: true,
    open: {
      where: "{a}.status = 'pending'",
      key: ["club_id"],
      end: { status: "'withdrawn'" },
      restore: ["status"],
    },
  },
];
