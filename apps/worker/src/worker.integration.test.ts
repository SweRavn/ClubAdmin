// SPDX-License-Identifier: AGPL-3.0-only
// Needs the local services: pnpm dev:services, then pnpm test:integration.
import { type OutboxHandler, sql } from "@clubadmin/db";
import { outbox } from "@clubadmin/db";
import {
  asPerson,
  createTestClubs,
  createTestDatabase,
  type TestDatabase,
} from "@clubadmin/db/testing";
import { createLogger } from "@clubadmin/server-kit";
import { uuidv7 } from "@clubadmin/shared";
import { runOnce } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { graphileLogger } from "./graphile-logger.ts";
import { createTaskList } from "./tasks/index.ts";

let t: TestDatabase;
const logger = graphileLogger(
  createLogger({
    service: "test",
    level: process.env.TEST_LOG_LEVEL === "debug" ? "debug" : "silent",
  }),
);

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe("worker with PostgreSQL (as clubadmin_app)", () => {
  it("dispatches committed outbox events to handlers once", async () => {
    const [club = ""] = createTestClubs(1);
    const personId = uuidv7();
    const received: string[] = [];
    const handler: OutboxHandler = {
      name: "test.collect",
      types: ["membership.changed"],
      handle: (event) => {
        received.push(event.id);
        return Promise.resolve();
      },
    };
    const eventId = await t.db.withTenant(asPerson(personId, club), (tx) =>
      outbox.publish(tx, "membership.changed", { clubId: club, personId }),
    );
    const taskList = createTaskList({
      db: t.db,
      outboxHandlers: [handler],
      historyRetentionMonths: 24,
      historyPartitionsAhead: 3,
    });
    await runOnce({ connectionString: t.url("app"), taskList, logger });

    expect(received).toEqual([eventId]);
    const { rows } = await t.query("admin", "SELECT status FROM outbox.events WHERE id = $1", [
      eventId,
    ]);
    expect(rows[0]).toEqual({ status: "done" });
  });

  it("maintains history partitions as the app role", async () => {
    await t.query("admin", "SELECT graphile_worker.add_job('history:maintain_partitions', '{}')");
    const taskList = createTaskList({
      db: t.db,
      outboxHandlers: [],
      historyRetentionMonths: 24,
      historyPartitionsAhead: 6,
    });
    await runOnce({ connectionString: t.url("app"), taskList, logger });
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'history.record_changes'::regclass",
    );
    expect(rows[0]?.n).toBe(8); // current month + 6 ahead + default
    const done = await t.query("admin", "SELECT count(*)::int AS n FROM graphile_worker.jobs");
    expect(done.rows[0]).toEqual({ n: 0 });
  });

  it("does not let the app role run DDL", async () => {
    await expect(
      t.db.withActor({ actorKind: "anonymous" }, (tx) =>
        tx.execute(sql`CREATE TABLE public.nope (id int)`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
