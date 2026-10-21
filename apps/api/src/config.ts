// SPDX-License-Identifier: AGPL-3.0-only
import { baseConfigShape, envBoolean, envList, parseConfig } from "@clubadmin/server-kit";
import { z } from "@clubadmin/shared";

export const apiConfigSchema = z
  .object({
    ...baseConfigShape,
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    PUBLIC_WEB_URL: z.url().default("https://clubadmin.localhost"),
    /** Origins allowed to call the API from a browser (comma-separated). Defaults to PUBLIC_WEB_URL. */
    CORS_ORIGINS: envList(),
    /** Fastify trustProxy: which proxies may set X-Forwarded-For (Caddy). */
    TRUST_PROXY: z.string().default("loopback,uniquelocal"),
    DATABASE_URL: z.string().optional(),
    VALKEY_URL: z.string().optional(),
    /** Field encryption master keys, `id:base64key` comma-separated, current first (docs/security.md). */
    ENCRYPTION_MASTER_KEYS: z.string().optional(),
    /** Key for blind indexes (matching encrypted values), base64, 32 bytes. */
    BLIND_INDEX_KEY: z.string().optional(),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /** Serve /api/v1/openapi.json. Defaults to on in development only. */
    OPENAPI_ENABLED: envBoolean(false).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === "production") {
      for (const key of [
        "DATABASE_URL",
        "VALKEY_URL",
        "ENCRYPTION_MASTER_KEYS",
        "BLIND_INDEX_KEY",
      ] as const) {
        if (!config[key])
          ctx.addIssue({ code: "custom", path: [key], message: "required in production" });
      }
    }
  })
  .transform((config) => ({
    ...config,
    CORS_ORIGINS:
      config.CORS_ORIGINS.length > 0
        ? config.CORS_ORIGINS
        : [new URL(config.PUBLIC_WEB_URL).origin],
    OPENAPI_ENABLED: config.OPENAPI_ENABLED ?? config.NODE_ENV === "development",
  }));

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig =>
  parseConfig(apiConfigSchema, env);

/** Dependency-injection token for the configuration. */
export const API_CONFIG = Symbol("API_CONFIG");
