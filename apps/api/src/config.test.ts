// SPDX-License-Identifier: AGPL-3.0-only
import { ConfigError } from "@clubadmin/server-kit";
import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.ts";

const key = "k".repeat(32);

describe("DEV_AUTH startup guard", () => {
  it("is allowed in development on a self-hosted deployment", () => {
    expect(
      loadApiConfig({ NODE_ENV: "development", DEV_AUTH: "true", DEV_AUTH_KEY: key }).DEV_AUTH,
    ).toBe(true);
  });

  it("refuses to start in production, in tests and on the hosted service", () => {
    for (const env of [
      {
        NODE_ENV: "production",
        DATABASE_URL: "x",
        VALKEY_URL: "x",
        ENCRYPTION_MASTER_KEYS: "x",
        BLIND_INDEX_KEY: "x",
      },
      { NODE_ENV: "test" },
      { NODE_ENV: "development", DEPLOYMENT_MODE: "hosted" },
    ]) {
      expect(() => loadApiConfig({ ...env, DEV_AUTH: "true", DEV_AUTH_KEY: key })).toThrow(
        ConfigError,
      );
      expect(() => loadApiConfig({ ...env, DEV_AUTH: "true", DEV_AUTH_KEY: key })).toThrow(
        /DEV_AUTH/,
      );
    }
  });

  it("needs the development key", () => {
    expect(() => loadApiConfig({ NODE_ENV: "development", DEV_AUTH: "true" })).toThrow(
      /DEV_AUTH_KEY/,
    );
  });
});
