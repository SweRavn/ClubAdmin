// SPDX-License-Identifier: AGPL-3.0-only
// Structured JSON logging (pino). Every log object is passed through the
// shared redaction, so personal data and secrets never reach the logs
// (CLAUDE.md rule 5). Log IDs, not names.

import { redact } from "@clubadmin/shared";
import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions["level"];
  /** For tests: write to this stream instead of stdout. */
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const config: LoggerOptions = {
    level: options.level ?? "info",
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redact(object) as Record<string, unknown>,
    },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
