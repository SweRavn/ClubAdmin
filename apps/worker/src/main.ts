// SPDX-License-Identifier: AGPL-3.0-only
import { createDatabase } from "@clubadmin/db";
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";
import {
  FILE_EXPIRY_RULES,
  ObjectStorage,
  objectStorageConfig,
} from "@clubadmin/server-kit/object-storage";
import { run } from "graphile-worker";
import { Redis } from "ioredis";

import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { smtpMailProvider } from "./mail.ts";
import { createOutboxHandlers } from "./outbox-handlers.ts";
import { BILLING_CRONTAB, createTaskList, crontab } from "./tasks/index.ts";

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
const storageConfig = objectStorageConfig(config);
const storage = storageConfig ? new ObjectStorage(storageConfig) : null;
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
    outboxHandlers: createOutboxHandlers({
      valkey,
      billing: config.BILLING_ENABLED
        ? {
            hosted: config.DEPLOYMENT_MODE === "hosted",
            defaultPlan: config.BILLING_DEFAULT_PLAN,
            trialDays: config.BILLING_TRIAL_DAYS,
          }
        : undefined,
      mail: config.SMTP_URL
        ? {
            provider: smtpMailProvider({ url: config.SMTP_URL, from: config.MAIL_FROM_ADDRESS }),
            webUrl: config.PUBLIC_WEB_URL,
            invitationTokenKey: config.INVITATION_TOKEN_KEY,
          }
        : undefined,
    }),
    historyRetentionMonths: config.HISTORY_RETENTION_MONTHS,
    historyPartitionsAhead: config.HISTORY_PARTITIONS_AHEAD,
    storage,
    defaultCountry: config.DEFAULT_COUNTRY,
  }),
  crontab: config.BILLING_ENABLED ? `${crontab}\n${BILLING_CRONTAB}` : crontab,
});
logger.info(
  {
    concurrency: config.WORKER_CONCURRENCY,
    mail: config.SMTP_URL ? "smtp" : "off",
    objectStorage: storage ? "s3" : "off",
  },
  "worker started",
);

// Backstop for member exports (P1.2) and import files (P1.3b): the bucket
// deletes them after two days even if the jobs that delete them do not run.
if (storage) {
  storage
    .ensureExpiryRules(FILE_EXPIRY_RULES)
    .then((result) => {
      if (result === "conflict") {
        logger.warn(
          "the files bucket has other lifecycle rules: add ones for exports/ and imports/ (docs/gdpr.md)",
        );
      }
    })
    .catch((error: unknown) =>
      logger.warn({ err: error }, "could not set the bucket lifecycle rule"),
    );
}

onShutdown(logger, async () => {
  await runner.stop();
  await db.close();
  await valkey?.quit();
});
