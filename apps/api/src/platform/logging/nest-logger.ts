// SPDX-License-Identifier: AGPL-3.0-only
import type { Logger } from "@clubadmin/server-kit";
import type { LoggerService } from "@nestjs/common";

/** Routes Nest's own log output through the redacting pino logger. */
export class NestPinoLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "nest" });
  }

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.logger.error({ context: context ?? stackOrContext }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
