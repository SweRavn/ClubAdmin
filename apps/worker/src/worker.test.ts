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
  it("schedules heartbeat, history maintenance and the adult-ward check; every cron task exists", () => {
    const items = parseCrontab(crontab);
    expect(items.map((i) => i.task)).toEqual([
      "heartbeat",
      "history:maintain_partitions",
      "guardianships:flag_adult_wards",
    ]);
    for (const item of items) expect(taskList[item.task]).toBeTypeOf("function");
  });

  it("has a task for the outbox trigger's jobs", () => {
    expect(taskList["outbox:dispatch"]).toBeTypeOf("function");
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
