// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";

import { cruise, type ICruiseResult } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

import config from "../../../dependency-cruiser.config.mjs";

const fixtureRoot = fileURLToPath(new URL("../fixtures/depcruise", import.meta.url));

describe("dependency-cruiser rules", () => {
  it("reports module internals, packages importing apps and apps importing other apps", async () => {
    const result = await cruise(["apps", "packages"], {
      validate: true,
      ruleSet: { forbidden: config.forbidden ?? [] },
      baseDir: fixtureRoot,
      tsPreCompilationDeps: true,
      enhancedResolveOptions: { extensions: [".ts"] },
    });
    const violations = (result.output as ICruiseResult).summary.violations.map(
      (v) => `${v.rule.name}: ${v.from} -> ${v.to}`,
    );
    expect(violations.sort()).toEqual([
      "apps-import-other-apps: apps/web/src/page.ts -> apps/api/src/modules/clubs/index.ts",
      "module-internals: apps/api/src/modules/groups/groups.service.ts -> apps/api/src/modules/clubs/clubs.repository.ts",
      "packages-import-apps: packages/shared/src/index.ts -> apps/api/src/modules/groups/groups.service.ts",
    ]);
  });
});
