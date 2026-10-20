// SPDX-License-Identifier: AGPL-3.0-only
// Sends Graphile Worker's logs through the redacting pino logger.
import type { Logger } from "@clubadmin/server-kit";
import { Logger as GraphileLogger, type LogLevel } from "graphile-worker";

export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger(
    (scope) => (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
      const fields = { ...scope, ...meta };
      switch (level) {
        case "error":
          logger.error(fields, message);
          break;
        case "warning":
          logger.warn(fields, message);
          break;
        case "debug":
          logger.debug(fields, message);
          break;
        default:
          logger.info(fields, message);
      }
    },
  );
}
