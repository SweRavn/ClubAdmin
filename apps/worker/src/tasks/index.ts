// SPDX-License-Identifier: AGPL-3.0-only
// Task handlers. Payloads contain IDs only, never personal data, because job
// rows are stored in the database and may appear in logs.

import { type Database, type LedgerSettings, outbox, type OutboxHandler, sql } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import type { PaymentProvider } from "@clubadmin/server-kit/payments";
import { z } from "@clubadmin/shared";
import type { Task, TaskList } from "graphile-worker";

import {
  billingDailyTask,
  billingRetentionTask,
  chargeTask,
  providerEventTask,
  type SendDependencies,
  sendInvoiceTask,
} from "../billing.ts";
import {
  deliverTask,
  type DeliveryDependencies,
  pushReceiptsTask,
} from "../notifications/deliver.ts";
import {
  eventRemindersTask,
  fanoutTask,
  notificationsRetentionTask,
  responseRemindersTask,
} from "../notifications/tasks.ts";
import { attendanceRetentionTask } from "./attendance.ts";
import { backupMetricsTask } from "./backup-metrics.ts";
import { calendarRetentionTask } from "./calendar.ts";
import { flagAdultWardsTask } from "./guardianships.ts";
import { joiningRetentionTask } from "./joining.ts";
import { expireMemberExportsTask, memberExportTask, purgeMemberImportsTask } from "./members.ts";
import {
  applyDecisionsTask,
  auditRetentionTask,
  expireDataExportsTask,
  type PrivacyJobOptions,
  privacyRetentionTask,
  protectionChangedTask,
  purgeMemberTask,
} from "./privacy.ts";
import { anonymizeProfileViewsTask, profileViewsRetentionTask } from "./profile-views.ts";
import { waitlistOffersTask } from "./waitlists.ts";

export interface TaskDependencies {
  db: Database;
  outboxHandlers: readonly OutboxHandler[];
  historyRetentionMonths: number;
  historyPartitionsAhead: number;
  /** S3_* (member exports); null when not configured. */
  storage?: ObjectStorage | null;
  /** DEFAULT_COUNTRY: age rules for wards without clubs (P1.3). */
  defaultCountry?: string;
  /** Notifications (P1.7): delivery by email and push; without it nothing is delivered. */
  delivery?: Omit<DeliveryDependencies, "db"> | undefined;
  /** Privacy jobs (P1.8a): the retention handle and the installation's periods. */
  privacy?: PrivacyJobOptions | undefined;
  /** Billing on (P1.13): the ledger's settings and the invoice email; without it no billing jobs. */
  billing?:
    | {
        settings: LedgerSettings;
        send: Omit<SendDependencies, "db" | "storage">;
        /** The card provider (P1.13 part B), or null: invoice only. */
        payments?: PaymentProvider | null;
      }
    | undefined;
}

/** Does nothing; used to check that jobs are picked up. */
export const noop: Task = (_payload, helpers) => {
  helpers.logger.debug("noop job ran", { jobId: helpers.job.id });
};

/** Runs every minute (crontab) to show that scheduling works. */
export const heartbeat: Task = (_payload, helpers) => {
  helpers.logger.info("heartbeat", {
    jobId: helpers.job.id,
    runAt: helpers.job.run_at.toISOString(),
  });
};

const DispatchPayload = z.object({ eventId: z.uuid() });

/** Delivers one outbox event to its handlers (job enqueued by the outbox trigger). */
export function outboxDispatch(deps: TaskDependencies): Task {
  return async (payload, helpers) => {
    const { eventId } = DispatchPayload.parse(payload);
    try {
      const result = await outbox.dispatch(deps.db, eventId, deps.outboxHandlers);
      helpers.logger.debug("outbox event dispatched", { eventId, result });
    } catch (error) {
      // Graphile Worker retries with exponential backoff until max_attempts.
      const permanent = helpers.job.attempts >= helpers.job.max_attempts;
      await outbox.recordFailure(deps.db, eventId, error, permanent);
      if (permanent) {
        helpers.logger.error("outbox event failed permanently", {
          eventId,
          attempts: helpers.job.attempts,
        });
      }
      throw error;
    }
  };
}

/** Creates upcoming history partitions and drops expired ones (ADR 0017). */
export function maintainHistoryPartitions(deps: TaskDependencies): Task {
  return async (_payload, helpers) => {
    const result = await deps.db.withSystem("history:maintain_partitions", {}, (tx) =>
      tx.execute<{ action: string; partition_name: string }>(
        sql`SELECT * FROM history.maintain_partitions(${deps.historyPartitionsAhead}, ${deps.historyRetentionMonths})`,
      ),
    );
    for (const row of result.rows) {
      helpers.logger.info(`history partition ${row.action}`, { partition: row.partition_name });
    }
  };
}

export function createTaskList(deps: TaskDependencies): TaskList {
  return {
    noop,
    heartbeat,
    "outbox:dispatch": outboxDispatch(deps),
    "history:maintain_partitions": maintainHistoryPartitions(deps),
    "guardianships:flag_adult_wards": flagAdultWardsTask(deps.db, {
      defaultCountry: deps.defaultCountry ?? "SE",
    }),
    "ops:backup_metrics": backupMetricsTask(deps.db),
    "joining:retention": joiningRetentionTask(deps.db),
    "waitlists:offers": waitlistOffersTask(deps.db),
    "calendar:retention": calendarRetentionTask(deps.db),
    "privacy:anonymize_profile_views": anonymizeProfileViewsTask(deps.db),
    "privacy:profile_views": profileViewsRetentionTask(deps.db),
    "attendance:retention": attendanceRetentionTask(deps.db),
    "members:export": memberExportTask(deps.db, deps.storage ?? null),
    "members:expire_exports": expireMemberExportsTask(deps.db, deps.storage ?? null),
    "members:purge_imports": purgeMemberImportsTask(deps.db, deps.storage ?? null),
    ...billingTasks(deps),
    ...notificationTasks(deps),
    ...privacyTasks(deps),
  };
}

/** Billing (P1.13): registered only with BILLING_ENABLED=true. */
function billingTasks(deps: TaskDependencies): TaskList {
  if (!deps.billing) return {};
  return {
    "billing:daily": billingDailyTask(deps.db, deps.billing.settings),
    "billing:send_invoice": sendInvoiceTask({
      db: deps.db,
      storage: deps.storage ?? null,
      ...deps.billing.send,
    }),
    "billing:charge": chargeTask(deps.db, deps.billing.payments ?? null),
    "billing:provider_event": providerEventTask(deps.db, deps.billing.payments ?? null),
    "billing:retention": billingRetentionTask(
      deps.privacy?.retentionDb ?? null,
      deps.storage ?? null,
    ),
  };
}

function privacyTasks(deps: TaskDependencies): TaskList {
  const options: PrivacyJobOptions = deps.privacy ?? {
    retentionDb: null,
    orphanRetentionMonths: 36,
    auditRetentionMonths: 24,
  };
  return {
    "privacy:retention": privacyRetentionTask(options),
    "privacy:purge_member": purgeMemberTask(options),
    "privacy:protection_changed": protectionChangedTask(options),
    "privacy:expire_exports": expireDataExportsTask(deps.db, deps.storage ?? null),
    "audit:retention": auditRetentionTask(options),
    "clubs:apply_decisions": applyDecisionsTask(deps.db, options),
  };
}

function notificationTasks(deps: TaskDependencies): TaskList {
  const channels = { email: Boolean(deps.delivery?.mail), push: Boolean(deps.delivery?.push) };
  const delivery: DeliveryDependencies = {
    db: deps.db,
    mail: null,
    push: null,
    tokenKey: undefined,
    webUrl: "https://clubadmin.invalid",
    mailOptions: { webUrl: "https://clubadmin.invalid", invitationTokenKey: undefined },
    pushPerHour: 10,
    ...deps.delivery,
  };
  return {
    "notifications:fanout": fanoutTask({ db: deps.db, channels }),
    "notifications:deliver": deliverTask(delivery),
    "notifications:push_receipts": pushReceiptsTask(delivery),
    "notifications:response_reminders": responseRemindersTask({ db: deps.db, channels }),
    "notifications:event_reminders": eventRemindersTask({ db: deps.db, channels }),
    "notifications:retention": notificationsRetentionTask(deps.db),
  };
}

/**
 * Graphile Worker crontab: heartbeat every minute (at most one queued),
 * history partition maintenance daily at 03:17 UTC and the wards' age checks
 * (adult age, own-login age) daily at 04:23 UTC (both catching up after
 * downtime), backup metrics every
 * five minutes, joining retention daily at 04:53 UTC, answers and attendance
 * past their club's retention daily at 05:07 UTC (#18), expired member
 * exports every ten minutes and member import staging data hourly (P1.3b);
 * notifications (P1.7): delivery every minute (also woken when notices are
 * created), reminders and push receipts every 15 minutes, retention daily
 * at 05:37 UTC; privacy (P1.8a): board decisions taking effect at 00:17
 * UTC, former members and orphaned people at 05:31 UTC, the audit log at
 * 05:43 UTC; "download my data" files past seven days hourly at :07 (P1.8b);
 * waiting-list offers (expiry, auto-offers) every five minutes (P1.10b);
 * calendar subscriptions unused for 12 months or revoked 30 days ago daily
 * at 05:13 UTC (P1.11); the profile view log (anonymising people who left
 * a club, rows after 24 months, the anonymisation ledger after 13) daily at
 * 05:19 UTC (P1.12).
 */
export const crontab = [
  "* * * * * heartbeat ?max=1",
  "17 3 * * * history:maintain_partitions ?fill=2d",
  "23 4 * * * guardianships:flag_adult_wards ?fill=2d",
  "*/5 * * * * ops:backup_metrics ?max=1",
  "53 4 * * * joining:retention ?fill=2d",
  "7 5 * * * attendance:retention ?fill=2d",
  "*/10 * * * * members:expire_exports ?max=1",
  "17 * * * * members:purge_imports ?max=1",
  "* * * * * notifications:deliver ?max=1&jobKey=notifications:deliver",
  "*/15 * * * * notifications:response_reminders ?max=1",
  "*/15 * * * * notifications:event_reminders ?max=1",
  "*/15 * * * * notifications:push_receipts ?max=1",
  "37 5 * * * notifications:retention ?fill=2d",
  "17 0 * * * clubs:apply_decisions ?fill=2d",
  "31 5 * * * privacy:retention ?fill=2d",
  "7 * * * * privacy:expire_exports ?max=1",
  "43 5 * * * audit:retention ?fill=2d",
  "*/5 * * * * waitlists:offers ?max=1",
  "13 5 * * * calendar:retention ?fill=2d",
  "19 5 * * * privacy:profile_views ?fill=2d",
].join("\n");

/**
 * Added to the crontab only with BILLING_ENABLED=true (P1.13): billing:daily
 * at 04:41 UTC (trials, changes, invoices, dunning) and the retention of
 * accounting records on 2 January at 03:29 UTC.
 */
export const BILLING_CRONTAB = [
  "41 4 * * * billing:daily ?fill=2d",
  "29 3 2 1 * billing:retention ?fill=7d",
].join("\n");
