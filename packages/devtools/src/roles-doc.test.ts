// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROLES_DOC_PATH, rolesDoc } from "./roles-doc.ts";

describe("docs/roles-and-permissions.md", () => {
  it("is generated from the catalogue (run `pnpm docs:roles`)", () => {
    expect(readFileSync(ROLES_DOC_PATH, "utf8")).toBe(rolesDoc());
  });
});
