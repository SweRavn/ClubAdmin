// SPDX-License-Identifier: AGPL-3.0-only
import { Writable } from "node:stream";

import { createLogger } from "@clubadmin/server-kit";
import { parseCrontab } from "graphile-worker";
import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { crontab, taskList } from "./tasks/index.ts";

describe("worker", () => {
  it("schedules the heartbeat every minute and every cron task exists", () => {
    const items = parseCrontab(crontab);
    expect(items.map((i) => i.task)).toEqual(["heartbeat"]);
    for (const item of items) expect(taskList[item.task]).toBeTypeOf("function");
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
