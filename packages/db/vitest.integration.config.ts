// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests against the local PostgreSQL (pnpm dev:services).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["./src/testing/global-setup.ts"],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
