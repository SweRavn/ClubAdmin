// SPDX-License-Identifier: AGPL-3.0-only
// The history view policy and the audit catalogue against the message
// catalogues (P1.9): every label and enum the policy uses, every resource,
// verb, own sentence and category, in sv and en (nb falls back to en).

import { catalogues } from "@clubadmin/i18n";
import {
  AUDIT_ACTION_SENTENCES,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_VERBS,
  auditCategoryOf,
  auditSentenceKey,
  CLUB_HISTORY_RESOURCES,
  HISTORY_RESOURCES,
} from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { HISTORY_POLICY, policyMessageKeys, ruleOf } from "./history-columns.ts";

const lookup = (catalogue: unknown, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalogue,
    );

const missingIn = (keys: readonly string[], kind: "string" | "object") =>
  Object.fromEntries(
    (["sv", "en"] as const).map((locale) => [
      locale,
      keys.filter((k) => typeof lookup(catalogues[locale], k) !== kind),
    ]),
  );

describe("history view policy", () => {
  it("leaves columns it does not list unnamed, and the row's bookkeeping hidden", () => {
    const groups = HISTORY_POLICY.find((p) => p.table === "public.groups")!;
    expect(ruleOf(groups, "a_column_added_later")).toBe("name_only");
    for (const column of ["id", "club_id", "created_at", "updated_at"]) {
      expect(ruleOf(groups, column)).toBe("hidden");
    }
  });

  it("never shows sealed sensitive answers, hashes or tokens", () => {
    const rule = (table: string, column: string) =>
      ruleOf(
        HISTORY_POLICY.find((p) => p.table === table)!,
        column,
      );
    expect(rule("public.event_registrations", "sensitive_answers")).toBe("hidden");
    expect(rule("public.people", "personal_identity_number_hash")).toBe("hidden");
    expect(rule("public.invitations", "token_hash")).toBe("hidden");
    expect(rule("public.people", "personal_identity_number")).toBe("name_only");
  });

  it("lists the club rows' resources for the club-wide filter", () => {
    expect([...CLUB_HISTORY_RESOURCES].sort()).toEqual(
      HISTORY_POLICY.filter((p) => !p.global)
        .map((p) => p.resource)
        .sort(),
    );
  });

  it("has one policy per table and per resource", () => {
    expect(new Set(HISTORY_POLICY.map((p) => p.table)).size).toBe(HISTORY_POLICY.length);
    expect(new Set(HISTORY_POLICY.map((p) => p.resource)).size).toBe(HISTORY_POLICY.length);
  });

  it("has every label and enum it uses in sv and en", () => {
    const { labels, enums } = policyMessageKeys();
    expect(missingIn(labels, "string")).toEqual({ sv: [], en: [] });
    expect(missingIn(enums, "object")).toEqual({ sv: [], en: [] });
  });
});

describe("audit catalogue", () => {
  it("renders every registered action: its own sentence or its verb", () => {
    const keys = AUDIT_ACTIONS.map((a) => {
      const sentence = auditSentenceKey(a);
      return "own" in sentence ? `audit.actions.${sentence.own}` : `audit.verbs.${sentence.verb}`;
    });
    expect(missingIn([...new Set(keys)], "string")).toEqual({ sv: [], en: [] });
    expect(AUDIT_ACTION_SENTENCES.every((a) => AUDIT_ACTIONS.includes(a))).toBe(true);
    expect(AUDIT_VERBS.length).toBeLessThan(60);
  });

  it("names every resource and category", () => {
    expect(
      missingIn(
        HISTORY_RESOURCES.map((r) => `history.resources.${r}`),
        "string",
      ),
    ).toEqual({
      sv: [],
      en: [],
    });
    expect(
      missingIn(
        AUDIT_CATEGORIES.map((c) => `audit.categories.${c}`),
        "string",
      ),
    ).toEqual({
      sv: [],
      en: [],
    });
  });

  it("puts every action in a category", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_CATEGORIES).toContain(auditCategoryOf(action));
    }
    expect(auditCategoryOf("members.exported")).toBe("exports");
    expect(auditCategoryOf("club.role.assigned")).toBe("roles");
    expect(auditCategoryOf("consent.given")).toBe("privacy");
    expect(auditCategoryOf("attendance.corrected")).toBe("attendance");
  });
});
