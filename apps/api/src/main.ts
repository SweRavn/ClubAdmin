// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";

import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";

loadEnvFiles();
const config = loadApiConfig();
const logger = createLogger({ service: "clubadmin-api", level: config.LOG_LEVEL });

const app = await createApp(config, { logger });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
logger.info(
  { host: config.API_HOST, port: config.API_PORT, nodeEnv: config.NODE_ENV },
  "api listening",
);

onShutdown(logger, () => app.close());
