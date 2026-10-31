// SPDX-License-Identifier: AGPL-3.0-only
import { baseConfigShape, parseConfig } from "@clubadmin/server-kit";
import { notificationsConfigShape } from "@clubadmin/server-kit/notifications";
import {
  objectStorageConfigIssues,
  objectStorageConfigShape,
} from "@clubadmin/server-kit/object-storage";
import { z } from "@clubadmin/shared";

export const workerConfigSchema = z
  .object({
    ...baseConfigShape,
    ...objectStorageConfigShape,
    ...notificationsConfigShape,
    /** clubadmin_app connection: jobs and their database work are subject to row-level security. */
    DATABASE_URL: z.string().min(1, "required: the worker stores its jobs in PostgreSQL"),
    /** Valkey of the API: domain events invalidate its authorization caches. */
    VALKEY_URL: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    /** Fallback polling interval; jobs are normally picked up instantly via LISTEN/NOTIFY. */
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
    /** Record history kept for this many months (ADR 0017). */
    HISTORY_RETENTION_MONTHS: z.coerce.number().int().min(1).default(24),
    HISTORY_PARTITIONS_AHEAD: z.coerce.number().int().min(1).max(24).default(3),
    /** Transactional email (ADR 0032): an SMTP URL (smtp:// or smtps://, with credentials if needed). */
    SMTP_URL: z.string().optional(),
    MAIL_FROM_ADDRESS: z.email().default("noreply@clubadmin.invalid"),
    /** Links in emails point here. */
    PUBLIC_WEB_URL: z.url().default("https://clubadmin.localhost"),
  })
  .superRefine((config, ctx) => {
    // Unsubscribe links (email) and sealed push tokens need the key (P1.7).
    if ((config.SMTP_URL || config.PUSH_PROVIDER) && !config.NOTIFICATION_TOKEN_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["NOTIFICATION_TOKEN_KEY"],
        message: "required with SMTP_URL or PUSH_PROVIDER (at least 32 characters)",
      });
    }
    for (const issue of objectStorageConfigIssues(config)) {
      ctx.addIssue({ code: "custom", path: [issue.variable], message: issue.message });
    }
  });

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  parseConfig(workerConfigSchema, env);
