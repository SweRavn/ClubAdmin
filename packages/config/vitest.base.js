// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

/** Shared Vitest defaults. Packages re-export this from their own vitest.config.ts. */
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "eslint/**/*.test.ts",
    ],
    environment: "node",
    passWithNoTests: false,
  },
});
