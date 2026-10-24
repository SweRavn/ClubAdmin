// SPDX-License-Identifier: AGPL-3.0-only
import { baseConfigShape, envBoolean, envList, parseConfig } from "@clubadmin/server-kit";
import {
  objectStorageConfigIssues,
  objectStorageConfigShape,
} from "@clubadmin/server-kit/object-storage";
import { AppVersionSchema, devAuthViolation, z } from "@clubadmin/shared";

export const apiConfigSchema = z
  .object({
    ...baseConfigShape,
    ...objectStorageConfigShape,
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
    /** OIDC issuer (Zitadel). Without it only DEV_AUTH tokens are accepted. */
    AUTH_ISSUER: z.url().optional(),
    /** Required audience of access tokens: the Zitadel project ID (pnpm auth:configure). */
    AUTH_AUDIENCE: z.string().optional(),
    /** Client ID of the mobile app in Zitadel (pnpm auth:configure): its sessions are listed in /me/sessions. */
    AUTH_MOBILE_CLIENT_ID: z.string().optional(),
    /** JWKS URL; defaults to the issuer's /oauth/v2/keys. */
    AUTH_JWKS_URL: z.url().optional(),
    /** Zitadel API base URL for session revocation; defaults to AUTH_ISSUER. */
    ZITADEL_API_URL: z.url().optional(),
    /** Token of the clubadmin-api machine user (pnpm auth:configure), to end Zitadel sessions. */
    ZITADEL_API_TOKEN: z.string().optional(),
    /** Development login (docs/seed-data.md); refused outside development. */
    DEV_AUTH: envBoolean(false),
    /** HS256 key shared with the web app for DEV_AUTH tokens (at least 32 characters). */
    DEV_AUTH_KEY: z.string().min(32).optional(),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** Requests per client IP and window without a valid login (docs/security.md, "Rate limits"). */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    /** Prefix of the rate-limit counters in Valkey (deployments or test runs sharing one Valkey). */
    RATE_LIMIT_NAMESPACE: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default("clubadmin"),
    /** Requests per account and window. */
    RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().positive().default(600),
    /** Requests per client IP and window with a login: a backstop for shared addresses. */
    RATE_LIMIT_IP_BACKSTOP: z.coerce.number().int().positive().default(6000),
    /** Bulk reads (endpoints marked bulkRead) per club and window. */
    RATE_LIMIT_CLUB_BULK_MAX: z.coerce.number().int().positive().default(1200),
    /** Bulk reads per account and window. */
    RATE_LIMIT_ACCOUNT_BULK_MAX: z.coerce.number().int().positive().default(240),
    /** Club searches, join requests, invitation acceptances and club creations per account and hour. */
    RATE_LIMIT_JOINING_MAX: z.coerce.number().int().positive().default(120),
    /** Member register exports (P1.2) per person and club, and per club, in 24 hours. */
    MEMBER_EXPORTS_PER_PERSON_DAY: z.coerce.number().int().positive().default(10),
    MEMBER_EXPORTS_PER_CLUB_DAY: z.coerce.number().int().positive().default(30),
    /** Member imports (P1.3b) started per club in 24 hours. */
    MEMBER_IMPORTS_PER_CLUB_DAY: z.coerce.number().int().positive().default(20),
    /** Invitations imports send per club in 24 hours (the rest are left out and counted). */
    MEMBER_IMPORT_INVITATIONS_PER_CLUB_DAY: z.coerce.number().int().positive().default(2000),
    /** Run the API jobs in this process (ADR 0033): member imports, expiring event offers (P1.6). */
    MEMBER_IMPORT_JOBS: envBoolean(true),
    /** Import jobs at a time in this process. */
    MEMBER_IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    /** Batches of one import written at the same time (database connections it uses). */
    MEMBER_IMPORT_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
    /** First logins (account creation) per client IP and minute. */
    RATE_LIMIT_PROVISIONING_MAX: z.coerce.number().int().positive().default(10),
    /** App versions below this must update (GET /meta/client, ADR 0029); per platform with _IOS / _ANDROID. */
    MOBILE_MIN_VERSION: AppVersionSchema.default("0.0.0"),
    MOBILE_MIN_VERSION_IOS: AppVersionSchema.optional(),
    MOBILE_MIN_VERSION_ANDROID: AppVersionSchema.optional(),
    /** App versions below this are asked to update. */
    MOBILE_RECOMMENDED_VERSION: AppVersionSchema.default("0.0.0"),
    MOBILE_RECOMMENDED_VERSION_IOS: AppVersionSchema.optional(),
    MOBILE_RECOMMENDED_VERSION_ANDROID: AppVersionSchema.optional(),
    /** Store pages of the published apps. */
    MOBILE_STORE_URL_IOS: z.url().optional(),
    MOBILE_STORE_URL_ANDROID: z.url().optional(),
    /** Feature flags for the apps: "name,other=false" (a bare name is on). */
    FEATURE_FLAGS: z.string().default(""),
    /** Backups are configured (infra/backup); otherwise GET /ops/backup-status warns. */
    BACKUP_ENABLED: envBoolean(false),
    /** Backup status warnings: database backup older than this many hours. */
    BACKUP_WARN_AFTER_HOURS: z.coerce.number().int().positive().default(24),
    /** File replication older than this many hours. */
    FILES_BACKUP_WARN_AFTER_HOURS: z.coerce.number().int().positive().default(3),
    /** No passed restore verification for this many days. */
    RESTORE_VERIFICATION_WARN_AFTER_DAYS: z.coerce.number().int().positive().default(8),
    /** Serve /api/v1/openapi.json. Defaults to on in development only. */
    OPENAPI_ENABLED: envBoolean(false).optional(),
  })
  .superRefine((config, ctx) => {
    const devAuth = devAuthViolation(config);
    if (devAuth) ctx.addIssue({ code: "custom", path: ["DEV_AUTH"], message: devAuth });
    for (const issue of objectStorageConfigIssues(config)) {
      ctx.addIssue({ code: "custom", path: [issue.variable], message: issue.message });
    }
    if (config.DEV_AUTH && !config.DEV_AUTH_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_AUTH_KEY"],
        message: "required when DEV_AUTH=true",
      });
    }
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

/** CLUB_CREATION, or its default: open on the hosted service, operators only when self-hosted (ADR 0018). */
export const clubCreationMode = (
  config: Pick<ApiConfig, "CLUB_CREATION" | "DEPLOYMENT_MODE">,
): "open" | "approval" | "operators_only" =>
  config.CLUB_CREATION ?? (config.DEPLOYMENT_MODE === "hosted" ? "open" : "operators_only");
