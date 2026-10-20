// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";
import { run } from "graphile-worker";

import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { crontab, taskList } from "./tasks/index.ts";

loadEnvFiles();
const config = loadWorkerConfig();
const logger = createLogger({ service: "clubadmin-worker", level: config.LOG_LEVEL });

const runner = await run({
  connectionString: config.DATABASE_URL,
  concurrency: config.WORKER_CONCURRENCY,
  pollInterval: config.WORKER_POLL_INTERVAL_MS,
  // Signals are handled below, so open jobs can finish before exit.
  noHandleSignals: true,
  logger: graphileLogger(logger),
  taskList,
  crontab,
});
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker started");

onShutdown(logger, () => runner.stop());
