// SPDX-License-Identifier: AGPL-3.0-only
// Server-side configuration of the web app (BFF), validated once. Values come
// from the environment (in development: the repository's .env.local, loaded
// by next.config.ts).

import { envBoolean, parseConfig } from "@clubadmin/server-kit/config";
import { devAuthViolation, z } from "@clubadmin/shared";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    DEPLOYMENT_MODE: z.enum(["self_hosted", "hosted"]).default("self_hosted"),
    PUBLIC_WEB_URL: z.url().default("https://clubadmin.localhost"),
    /** The API as the BFF reaches it (server to server). */
    API_INTERNAL_URL: z.url().default("http://127.0.0.1:4000"),
    VALKEY_URL: z.string().default("redis://127.0.0.1:6379"),
    /** AES-256-GCM key (base64, 32 bytes) for the tokens in session records. */
    SESSION_ENCRYPTION_KEY: z.string().optional(),
    AUTH_ISSUER: z.url().optional(),
    AUTH_WEB_CLIENT_ID: z.string().optional(),
    AUTH_WEB_CLIENT_SECRET: z.string().optional(),
    /** Zitadel project; requested as audience so the API accepts the access token. */
    AUTH_PROJECT_ID: z.string().optional(),
    DEV_AUTH: envBoolean(false),
    DEV_AUTH_KEY: z.string().min(32).optional(),
    /** Login attempts (/auth/*) per client IP and minute. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  })
  .superRefine((config, ctx) => {
    const devAuth = devAuthViolation(config);
    if (devAuth) ctx.addIssue({ code: "custom", path: ["DEV_AUTH"], message: devAuth });
    if (config.DEV_AUTH && !config.DEV_AUTH_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_AUTH_KEY"],
        message: "required when DEV_AUTH=true",
      });
    }
    if (config.NODE_ENV === "production" && !config.SESSION_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_ENCRYPTION_KEY"],
        message: "required in production",
      });
    }
  });

export type WebConfig = z.infer<typeof schema>;

export const parseWebConfig = (env: NodeJS.ProcessEnv): WebConfig => parseConfig(schema, env);

let cached: WebConfig | undefined;
export function webConfig(): WebConfig {
  cached ??= parseWebConfig(process.env);
  return cached;
}

/** Real login is configured (Zitadel client registered by pnpm auth:configure). */
export const oidcConfigured = (config: WebConfig): boolean =>
  Boolean(config.AUTH_ISSUER && config.AUTH_WEB_CLIENT_ID && config.AUTH_WEB_CLIENT_SECRET);
