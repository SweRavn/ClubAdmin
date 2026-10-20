// SPDX-License-Identifier: AGPL-3.0-only
// Typed configuration from environment variables, validated once at startup.

import { z } from "@clubadmin/shared";

export class ConfigError extends Error {
  readonly issues: { variable: string; message: string }[];

  constructor(issues: { variable: string; message: string }[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n")}\n` +
        "See .env.example for all variables.",
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** "true"/"false"/"1"/"0" (case-insensitive) → boolean. */
export const envBoolean = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0", "TRUE", "FALSE", "True", "False"])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v.toLowerCase() === "true");

/** Comma-separated list → string[]. */
export const envList = (defaultValue = "") =>
  z
    .string()
    .default(defaultValue)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

/** Settings every server process shares (see docs/hosting-and-billing.md). */
export const baseConfigShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEPLOYMENT_MODE: z.enum(["self_hosted", "hosted"]).default("self_hosted"),
  BILLING_ENABLED: envBoolean(false),
  USER_SIGNUP: z.enum(["open", "invite_only"]).default("open"),
  CLUB_CREATION: z.enum(["open", "approval", "operators_only"]).optional(),
  DEFAULT_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/, "two-letter country code")
    .default("SE"),
  APP_VERSION: z.string().default("0.0.0"),
  GIT_COMMIT: z.string().default("unknown"),
  SOURCE_URL: z.url().default("https://github.com/SweRavn/ClubAdmin"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
} as const;

export function parseConfig<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  // Empty strings count as "not set", so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}
