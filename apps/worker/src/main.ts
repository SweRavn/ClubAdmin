// SPDX-License-Identifier: AGPL-3.0-only
import { createDatabase } from "@clubadmin/db";
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";
import {
  FILE_EXPIRY_RULES,
  ObjectStorage,
  objectStorageConfig,
} from "@clubadmin/server-kit/object-storage";
import { paymentProvider } from "@clubadmin/server-kit/payments";
import { run } from "graphile-worker";
import { Redis } from "ioredis";

import { billingSettings } from "./billing.ts";
import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { smtpMailProvider } from "./mail.ts";
import { expoPushProvider, fakePushProvider } from "./notifications/push.ts";
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
// The privacy jobs' own handle (clubadmin_retention, P1.8a): one connection, one job at a time.
const retentionDb = config.DATABASE_RETENTION_URL
  ? createDatabase({
      url: config.DATABASE_RETENTION_URL,
      max: 1,
      applicationName: "clubadmin-worker-retention",
    })
  : null;
if (!retentionDb) logger.warn("DATABASE_RETENTION_URL is not set: the privacy jobs do nothing");
const valkey = config.VALKEY_URL
  ? new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 3, connectionName: "clubadmin-worker" })
  : undefined;
const storageConfig = objectStorageConfig(config);
const storage = storageConfig ? new ObjectStorage(storageConfig) : null;
// Reconnects automatically; a failed handler is retried by the outbox.
valkey?.on("error", () => undefined);

const mailProvider = config.SMTP_URL
  ? smtpMailProvider({ url: config.SMTP_URL, from: config.MAIL_FROM_ADDRESS })
  : null;
// Push (P1.7): Expo Push, or the fake provider in development and CI.
const pushProvider =
  config.PUSH_PROVIDER === "expo"
    ? expoPushProvider({ accessToken: config.EXPO_ACCESS_TOKEN })
    : config.PUSH_PROVIDER === "fake"
      ? fakePushProvider()
      : null;
// Billing (P1.13): the ledger's settings; the configuration requires the seller in production.
const billing = config.BILLING_ENABLED ? billingSettings(config) : null;

const emailCode = {
  webUrl: config.PUBLIC_WEB_URL,
  invitationTokenKey: config.INVITATION_TOKEN_KEY,
};

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
      billing: billing
        ? {
            hosted: config.DEPLOYMENT_MODE === "hosted",
            trialPlan: config.BILLING_TRIAL_PLAN ?? config.BILLING_DEFAULT_PLAN,
            trialDays: config.BILLING_TRIAL_DAYS,
            settings: billing,
          }
        : undefined,
      mail: mailProvider ? { provider: mailProvider, ...emailCode } : undefined,
      notifications: {
        channels: { email: mailProvider !== null, push: pushProvider !== null },
        mail: emailCode,
      },
    }),
    delivery: {
      mail: mailProvider,
      push: pushProvider,
      tokenKey: config.NOTIFICATION_TOKEN_KEY,
      webUrl: config.PUBLIC_WEB_URL,
      mailOptions: emailCode,
      pushPerHour: config.NOTIFY_PUSH_PER_PERSON_HOUR,
    },
    historyRetentionMonths: config.HISTORY_RETENTION_MONTHS,
    historyPartitionsAhead: config.HISTORY_PARTITIONS_AHEAD,
    storage,
    billing: billing
      ? {
          settings: billing,
          payments: paymentProvider(config),
          send: {
            mail: mailProvider,
            webUrl: config.PUBLIC_WEB_URL,
            emailLink: config.BILLING_INVOICE_EMAIL_LINK,
          },
        }
      : undefined,
    defaultCountry: config.DEFAULT_COUNTRY,
    privacy: {
      retentionDb,
      orphanRetentionMonths: config.ORPHAN_RETENTION_MONTHS,
      auditRetentionMonths: config.AUDIT_RETENTION_MONTHS,
    },
  }),
  crontab: config.BILLING_ENABLED ? `${crontab}\n${BILLING_CRONTAB}` : crontab,
});
logger.info(
  {
    concurrency: config.WORKER_CONCURRENCY,
    mail: config.SMTP_URL ? "smtp" : "off",
    push: pushProvider?.name ?? "off",
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
  await retentionDb?.close();
  await valkey?.quit();
});
