// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests against the local services (pnpm dev:services).
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite({ configFile: ".swcrc" })],
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["@clubadmin/db/testing/global-setup"],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
