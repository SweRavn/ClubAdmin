// SPDX-License-Identifier: AGPL-3.0-only
import { baseConfigShape, parseConfig } from "@clubadmin/server-kit";
import { z } from "@clubadmin/shared";

export const workerConfigSchema = z.object({
  ...baseConfigShape,
  DATABASE_URL: z.string().min(1, "required: the worker stores its jobs in PostgreSQL"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /** Fallback polling interval; jobs are normally picked up instantly via LISTEN/NOTIFY. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  parseConfig(workerConfigSchema, env);
