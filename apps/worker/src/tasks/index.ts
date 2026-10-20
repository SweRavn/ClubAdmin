// SPDX-License-Identifier: AGPL-3.0-only
// Task handlers. Payloads contain IDs only, never personal data, because job
// rows are stored in the database and may appear in logs.

import type { Task, TaskList } from "graphile-worker";

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

export const taskList: TaskList = { noop, heartbeat };

/** Graphile Worker crontab: every minute, at most one queued heartbeat. */
export const crontab = "* * * * * heartbeat ?max=1";
