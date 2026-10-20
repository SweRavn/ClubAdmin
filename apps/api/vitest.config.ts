// SPDX-License-Identifier: AGPL-3.0-only
// NestJS needs decorator metadata, which Vite's own TypeScript transform does
// not emit, so tests are compiled with SWC like the build (.swcrc).
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite({ configFile: ".swcrc" })],
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
