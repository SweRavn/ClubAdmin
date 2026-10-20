// SPDX-License-Identifier: AGPL-3.0-only
import base from "@clubadmin/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  base,
  defineConfig({ test: { exclude: ["src/**/*.integration.test.ts"] } }),
);
