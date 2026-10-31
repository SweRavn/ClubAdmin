// SPDX-License-Identifier: AGPL-3.0-only
import { Writable } from "node:stream";

import type { Database } from "@clubadmin/db";
import { createLogger } from "@clubadmin/server-kit";
import { parseCrontab } from "graphile-worker";
import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { createTaskList, crontab } from "./tasks/index.ts";

const taskList = createTaskList({
  db: {} as Database,
  outboxHandlers: [],
  historyRetentionMonths: 24,
  historyPartitionsAhead: 3,
});

describe("worker", () => {
  it("schedules heartbeat, history maintenance, the adult-ward check, backup metrics, joining and attendance retention, export expiry, import purging and notifications; every cron task exists", () => {
    const items = parseCrontab(crontab);
    expect(items.map((i) => i.task)).toEqual([
      "heartbeat",
      "history:maintain_partitions",
      "guardianships:flag_adult_wards",
      "ops:backup_metrics",
      "joining:retention",
      "attendance:retention",
      "members:expire_exports",
      "members:purge_imports",
      "notifications:deliver",
      "notifications:response_reminders",
      "notifications:event_reminders",
      "notifications:push_receipts",
      "notifications:retention",
    ]);
    for (const item of items) expect(taskList[item.task]).toBeTypeOf("function");
  });

  it("has a task for the jobs database triggers enqueue (outbox, member exports)", () => {
    expect(taskList["outbox:dispatch"]).toBeTypeOf("function");
    expect(taskList["members:export"]).toBeTypeOf("function");
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL/);
  });

  it("logs Graphile Worker messages through the redacting logger", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = graphileLogger(createLogger({ service: "test", destination }));
    logger.warn("job failed", { email: "anna@example.test", jobId: "1" });
    expect(lines.join("")).toContain('"level":"warn"');
    expect(lines.join("")).not.toContain("anna@example.test");
  });
});
