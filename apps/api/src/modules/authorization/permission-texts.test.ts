// SPDX-License-Identifier: AGPL-3.0-only
// Every permission a role can hold is explained in plain language in every
// language (P1.15 A1.1): a name, one sentence and an example; every area too.

import { catalogues, SUPPORTED_LOCALES } from "@clubadmin/i18n";
import { PERMISSION_AREAS, ROLE_PERMISSIONS } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

/** The message key of a permission (message keys cannot contain dots). */
const keyOf = (permission: string) => permission.replaceAll(".", "_");

describe("permission catalogue texts", () => {
  it.each(SUPPORTED_LOCALES)("are complete in %s", (locale) => {
    const messages = catalogues[locale] as unknown as {
      permissionCatalogue?: {
        areas: Record<string, string>;
        permissions: Record<string, { name: string; description: string; example: string }>;
      };
    };
    const texts = messages.permissionCatalogue;
    expect(texts, locale).toBeDefined();
    for (const area of PERMISSION_AREAS) expect(texts!.areas[area], area).toBeTruthy();
    const missing = ROLE_PERMISSIONS.filter((p) => {
      const t = texts!.permissions[keyOf(p)];
      return !t?.name || !t.description || !t.example;
    });
    expect(missing).toEqual([]);
    const extra = Object.keys(texts!.permissions).filter(
      (k) => !ROLE_PERMISSIONS.some((p) => keyOf(p) === k),
    );
    expect(extra).toEqual([]);
  });
});
