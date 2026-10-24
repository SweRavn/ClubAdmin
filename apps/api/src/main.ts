// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";

import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";
import { EventsService } from "./modules/events/index.ts";
import { MemberImportsService } from "./modules/members/index.ts";
import { startApiJobs } from "./platform/jobs/api-jobs.ts";

loadEnvFiles();
const config = loadApiConfig();
const logger = createLogger({ service: "clubadmin-api", level: config.LOG_LEVEL });

const app = await createApp(config, { logger });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
logger.info(
  { host: config.API_HOST, port: config.API_PORT, nodeEnv: config.NODE_ENV },
  "api listening",
);

// Jobs that use the domain services run here (ADR 0033): member imports
// (P1.3b) and expiring event offers (P1.6).
const importJobs =
  config.MEMBER_IMPORT_JOBS && config.DATABASE_URL
    ? await startApiJobs({
        databaseUrl: config.DATABASE_URL,
        concurrency: config.MEMBER_IMPORT_CONCURRENCY,
        imports: app.get(MemberImportsService),
        events: app.get(EventsService),
        logger,
      })
    : null;

onShutdown(logger, async () => {
  await importJobs?.stop();
  await app.close();
});
