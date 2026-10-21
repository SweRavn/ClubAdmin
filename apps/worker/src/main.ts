// SPDX-License-Identifier: AGPL-3.0-only
import { createDatabase } from "@clubadmin/db";
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";
import { run } from "graphile-worker";
import { Redis } from "ioredis";

import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { createOutboxHandlers } from "./outbox-handlers.ts";
import { createTaskList, crontab } from "./tasks/index.ts";

loadEnvFiles();
const config = loadWorkerConfig();
const logger = createLogger({ service: "clubadmin-worker", level: config.LOG_LEVEL });
const db = createDatabase({
  url: config.DATABASE_URL,
  max: config.WORKER_CONCURRENCY,
  applicationName: "clubadmin-worker",
});
const valkey = config.VALKEY_URL
  ? new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 3, connectionName: "clubadmin-worker" })
  : undefined;
// Reconnects automatically; a failed handler is retried by the outbox.
valkey?.on("error", () => undefined);

const runner = await run({
  connectionString: config.DATABASE_URL,
  concurrency: config.WORKER_CONCURRENCY,
  pollInterval: config.WORKER_POLL_INTERVAL_MS,
  // Signals are handled below, so open jobs can finish before exit.
  noHandleSignals: true,
  logger: graphileLogger(logger),
  taskList: createTaskList({
    db,
    outboxHandlers: createOutboxHandlers({ valkey }),
    historyRetentionMonths: config.HISTORY_RETENTION_MONTHS,
    historyPartitionsAhead: config.HISTORY_PARTITIONS_AHEAD,
  }),
  crontab,
});
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker started");

onShutdown(logger, async () => {
  await runner.stop();
  await db.close();
  await valkey?.quit();
});
