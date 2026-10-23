// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";

import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";
import { MemberImportsService } from "./modules/members/index.ts";
import { startMemberImportJobs } from "./platform/jobs/member-import-jobs.ts";

loadEnvFiles();
const config = loadApiConfig();
const logger = createLogger({ service: "clubadmin-api", level: config.LOG_LEVEL });

const app = await createApp(config, { logger });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
logger.info(
  { host: config.API_HOST, port: config.API_PORT, nodeEnv: config.NODE_ENV },
  "api listening",
);

// Member imports (P1.3b, ADR 0033): parsing and importing run here, next to the services.
const importJobs =
  config.MEMBER_IMPORT_JOBS && config.DATABASE_URL
    ? await startMemberImportJobs({
        databaseUrl: config.DATABASE_URL,
        concurrency: config.MEMBER_IMPORT_CONCURRENCY,
        imports: app.get(MemberImportsService),
        logger,
      })
    : null;

onShutdown(logger, async () => {
  await importJobs?.stop();
  await app.close();
});
