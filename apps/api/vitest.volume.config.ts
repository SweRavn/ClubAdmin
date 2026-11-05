// SPDX-License-Identifier: AGPL-3.0-only
// Volume tests (P1.9, ADR 0042): against the local database after
// `pnpm db:reset --scenario load && pnpm db:seed --history-volume`. Run by
// the Nightly workflow and by hand, never in the CI workflow.
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite({ configFile: ".swcrc" })],
  test: {
    include: ["src/**/*.volume.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
