// SPDX-License-Identifier: AGPL-3.0-only
// Task handlers. Payloads contain IDs only, never personal data, because job
// rows are stored in the database and may appear in logs.

import { type Database, outbox, type OutboxHandler, sql } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import { z } from "@clubadmin/shared";
import type { Task, TaskList } from "graphile-worker";

import { generateInvoicesTask } from "../billing.ts";
import { backupMetricsTask } from "./backup-metrics.ts";
import { flagAdultWardsTask } from "./guardianships.ts";
import { joiningRetentionTask } from "./joining.ts";
import { expireMemberExportsTask, memberExportTask } from "./members.ts";

export interface TaskDependencies {
  db: Database;
  outboxHandlers: readonly OutboxHandler[];
  historyRetentionMonths: number;
  historyPartitionsAhead: number;
  /** S3_* (member exports); null when not configured. */
  storage?: ObjectStorage | null;
  /** DEFAULT_COUNTRY: age rules for wards without clubs (P1.3). */
  defaultCountry?: string;
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
    "members:export": memberExportTask(deps.db, deps.storage ?? null),
    "members:expire_exports": expireMemberExportsTask(deps.db, deps.storage ?? null),
    "billing:generate_invoices": generateInvoicesTask,
  };
}

/**
 * Graphile Worker crontab: heartbeat every minute (at most one queued),
 * history partition maintenance daily at 03:17 UTC and the wards' age checks
 * (adult age, own-login age) daily at 04:23 UTC (both catching up after
 * downtime), backup metrics every
 * five minutes, joining retention daily at 04:53 UTC, expired member exports
 * every ten minutes.
 */
export const crontab = [
  "* * * * * heartbeat ?max=1",
  "17 3 * * * history:maintain_partitions ?fill=2d",
  "23 4 * * * guardianships:flag_adult_wards ?fill=2d",
  "*/5 * * * * ops:backup_metrics ?max=1",
  "53 4 * * * joining:retention ?fill=2d",
  "*/10 * * * * members:expire_exports ?max=1",
].join("\n");

/** Added to the crontab only with BILLING_ENABLED=true: invoicing on the 1st at 04:41 UTC. */
export const BILLING_CRONTAB = "41 4 1 * * billing:generate_invoices ?fill=2d";
