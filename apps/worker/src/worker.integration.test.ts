// SPDX-License-Identifier: AGPL-3.0-only
// Needs the local services: pnpm dev:services, then pnpm test:integration.
import { createLogger, loadEnvFiles } from "@clubadmin/server-kit";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { describe, expect, it } from "vitest";

import { graphileLogger } from "./graphile-logger.ts";
import { taskList } from "./tasks/index.ts";

loadEnvFiles();

describe("worker with PostgreSQL", () => {
  it("runs a queued job", async () => {
    const connectionString = process.env.DATABASE_URL ?? "";
    const logger = graphileLogger(createLogger({ service: "test", level: "silent" }));
    const utils = await makeWorkerUtils({ connectionString, logger });
    try {
      await utils.migrate();
      const job = await utils.addJob("noop", {}, { jobKey: `integration-${Date.now()}` });
      await runOnce({ connectionString, taskList, logger });
      const remaining = await utils.withPgClient((client) =>
        client.query("select count(*)::int as n from graphile_worker.jobs where id = $1", [job.id]),
      );
      expect(remaining.rows[0]).toEqual({ n: 0 });
    } finally {
      await utils.release();
    }
  });
});
