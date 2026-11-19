// SPDX-License-Identifier: AGPL-3.0-only
// "Who can …?" lists the permissions by their name in the viewer's language (P2.7b).
import { type Locale, translate } from "@clubadmin/i18n";
import { PERMISSION_CATALOGUE } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { byPermissionName, permissionName } from "./roles.ts";

const translator = (locale: Locale) =>
  ((key: string) => translate(locale, key as never)) as unknown as (key: never) => string;

describe("byPermissionName", () => {
  it.each(["sv", "en"] as const)("sorts by the name in %s, not by key", (locale) => {
    const t = translator(locale);
    const items = Object.entries(PERMISSION_CATALOGUE)
      .filter(([, entry]) => entry.kind === "role")
      .map(([permission]) => ({ permission }));
    const names = byPermissionName(t, locale, items).map((i) => permissionName(t, i.permission));
    expect(names).toEqual(
      [...names].sort(new Intl.Collator(locale, { sensitivity: "base" }).compare),
    );
    expect(names.every((n) => n && !n.startsWith("permissionCatalogue"))).toBe(true);
  });
});
