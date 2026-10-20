// SPDX-License-Identifier: AGPL-3.0-only
// Task handlers. Payloads contain IDs only, never personal data, because job
// rows are stored in the database and may appear in logs.

import { type Database, outbox, type OutboxHandler, sql } from "@clubadmin/db";
import { z } from "@clubadmin/shared";
import type { Task, TaskList } from "graphile-worker";

export interface TaskDependencies {
  db: Database;
  outboxHandlers: readonly OutboxHandler[];
  historyRetentionMonths: number;
  historyPartitionsAhead: number;
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
  };
}

/**
 * Graphile Worker crontab: heartbeat every minute (at most one queued), and
 * history partition maintenance daily at 03:17 UTC (also catching up after
 * downtime).
 */
export const crontab = [
  "* * * * * heartbeat ?max=1",
  "17 3 * * * history:maintain_partitions ?fill=2d",
].join("\n");
