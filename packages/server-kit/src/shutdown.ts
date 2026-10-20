// SPDX-License-Identifier: AGPL-3.0-only
import type { Logger } from "pino";

/**
 * Runs `close` once on SIGTERM/SIGINT, then exits. If closing takes longer
 * than `timeoutMs`, exits anyway with code 1.
 */
export function onShutdown(logger: Logger, close: () => Promise<void>, timeoutMs = 10_000): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown timed out");
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    close().then(
      () => {
        logger.info("shutdown complete");
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}
