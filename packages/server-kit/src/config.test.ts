// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { baseConfigShape, ConfigError, envBoolean, envList, parseConfig } from "./config.ts";

const schema = z.object({
  ...baseConfigShape,
  PORT: z.coerce.number().int().min(1).max(65535),
  FLAG: envBoolean(false),
  ORIGINS: envList("https://a.test"),
});

describe("parseConfig", () => {
  it("applies defaults and converts types", () => {
    const config = parseConfig(schema, { PORT: "4000", FLAG: "true", BILLING_ENABLED: "" });
    expect(config).toMatchObject({
      NODE_ENV: "production",
      PORT: 4000,
      FLAG: true,
      BILLING_ENABLED: false,
      ORIGINS: ["https://a.test"],
    });
  });

  it("names every invalid variable", () => {
    let error: unknown;
    try {
      parseConfig(schema, { PORT: "not-a-port", LOG_LEVEL: "loud" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("PORT");
    expect(message).toContain("LOG_LEVEL");
  });
});
