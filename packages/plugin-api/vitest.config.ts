// SPDX-License-Identifier: AGPL-3.0-only
import base from "@clubadmin/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

// The fixtures and scenario tests live in test/ (not shipped with the package).
export default mergeConfig(base, defineConfig({ test: { include: ["test/**/*.test.ts"] } }));
