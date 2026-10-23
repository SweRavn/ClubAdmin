// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests against the local services (pnpm dev:services). The tests
// that measure time against a budget run in a second pass (`--mode timed`),
// one file at a time: next to other files loading data in parallel, their
// timings measured the shared runner, not the code.
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const TIMED = [
  "src/modules/members/register-plans.integration.test.ts",
  "src/modules/members/member-imports.performance.integration.test.ts",
  "src/modules/activities/schedule-plans.integration.test.ts",
];

export default defineConfig(({ mode }) => ({
  plugins: [swc.vite({ configFile: ".swcrc" })],
  test: {
    include: mode === "timed" ? TIMED : ["src/**/*.integration.test.ts"],
    exclude: mode === "timed" ? [] : TIMED,
    fileParallelism: mode !== "timed",
    environment: "node",
    globalSetup: ["@clubadmin/db/testing/global-setup"],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
}));
