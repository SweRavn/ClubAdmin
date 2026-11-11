// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { CLUB_ROLES, GROUP_FUNCTIONS } from "../domain/core.ts";
import { PERMISSIONS } from "../permissions.ts";
import {
  BUILT_IN_ROLE_TEMPLATE,
  CAPABILITIES,
  isRolePermission,
  LOCKED_ROLES,
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  uncataloguedPermissions,
} from "./permission-catalogue.ts";

describe("permission catalogue (P1.15)", () => {
  it("classifies every endpoint permission and every capability", () => {
    expect(uncataloguedPermissions()).toEqual([]);
    for (const c of CAPABILITIES) expect(PERMISSION_CATALOGUE[c]?.kind, c).toBe("role");
    const known = new Set<string>([...PERMISSIONS, ...CAPABILITIES]);
    expect(Object.keys(PERMISSION_CATALOGUE).filter((k) => !known.has(k))).toEqual([]);
  });

  it("derives only from role permissions", () => {
    for (const [key, entry] of Object.entries(PERMISSION_CATALOGUE)) {
      if (entry.kind === "derived") expect(isRolePermission(entry.from), key).toBe(true);
    }
  });

  it("the built-in template covers today's roles and functions with role permissions only", () => {
    expect(Object.keys(BUILT_IN_ROLE_TEMPLATE).sort()).toEqual(
      [...CLUB_ROLES, ...GROUP_FUNCTIONS].sort(),
    );
    for (const [key, t] of Object.entries(BUILT_IN_ROLE_TEMPLATE)) {
      expect(
        t.permissions.filter((p) => !isRolePermission(p)),
        key,
      ).toEqual([]);
      expect(new Set(t.permissions).size, `${key} lists a permission twice`).toBe(
        t.permissions.length,
      );
      expect(t.scope).toBe((GROUP_FUNCTIONS as readonly string[]).includes(key) ? "group" : "club");
    }
  });

  it("locked roles hold their locked permissions; no group role holds a club permission", () => {
    for (const [role, locked] of Object.entries(LOCKED_ROLES)) {
      const held = BUILT_IN_ROLE_TEMPLATE[role as keyof typeof LOCKED_ROLES].permissions;
      for (const p of locked) expect(held, role).toContain(p);
    }
    for (const fn of GROUP_FUNCTIONS) {
      const clubScoped = BUILT_IN_ROLE_TEMPLATE[fn].permissions.filter((p) => {
        const entry = PERMISSION_CATALOGUE[p];
        return entry.kind === "role" && entry.scope === "club";
      });
      expect(clubScoped, fn).toEqual([]);
    }
  });

  it("every role permission is held by some template role (nothing unreachable)", () => {
    const held = new Set(Object.values(BUILT_IN_ROLE_TEMPLATE).flatMap((t) => t.permissions));
    expect(ROLE_PERMISSIONS.filter((p) => !held.has(p))).toEqual([]);
  });
});
