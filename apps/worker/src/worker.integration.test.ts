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
import { relationshipVersionKey, uuidv7 } from "@clubadmin/shared";
import { run, runOnce } from "graphile-worker";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { graphileLogger } from "./graphile-logger.ts";
import { createOutboxHandlers } from "./outbox-handlers.ts";
import { flagAdultWards } from "./tasks/guardianships.ts";
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

describe("guardianships:flag_adult_wards", () => {
  it("flags (never ends) guardianships of wards who reached the adult age, once", async () => {
    const { rows } = await t.query<{ adult: string; child: string }>(
      "admin",
      `WITH g AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('G', 'P', '1980-01-01') RETURNING id),
            a AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('A', 'P', '2008-06-01') RETURNING id),
            c AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('C', 'P', '2008-06-02') RETURNING id),
            ga AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT g.id, a.id, 'parent', '{}' FROM g, a RETURNING id),
            gc AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT g.id, c.id, 'parent', '{}' FROM g, c RETURNING id)
       SELECT (SELECT id FROM ga) AS adult, (SELECT id FROM gc) AS child`,
    );
    const ids = rows[0]!;
    // On 2026-06-01 the first ward turns 18, the second the day after.
    expect(await flagAdultWards(t.db, "2026-06-01")).toBe(1);
    expect(await flagAdultWards(t.db, "2026-06-01")).toBe(0);

    const { rows: state } = await t.query<{ id: string; status: string; flagged: boolean }>(
      "admin",
      "SELECT id, status, ward_adult_flagged_at IS NOT NULL AS flagged FROM guardianships WHERE id = ANY ($1) ORDER BY id",
      [[ids.adult, ids.child]],
    );
    expect(state).toEqual(
      [
        { id: ids.adult, status: "active", flagged: true },
        { id: ids.child, status: "active", flagged: false },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'guardianship.ward.adult' AND payload ->> 'guardianshipId' = $1",
      [ids.adult],
    );
    expect(events[0]?.n).toBe(1);
  });
});

describe("authorization cache invalidation", () => {
  it("bumps the relationship version within a second of a committed role change", async () => {
    const valkey = new Redis(process.env.VALKEY_URL ?? "redis://127.0.0.1:6379");
    const runner = await run({
      connectionString: t.url("app"),
      concurrency: 2,
      noHandleSignals: true,
      pollInterval: 60_000, // LISTEN/NOTIFY must deliver the job, not polling
      logger,
      taskList: createTaskList({
        db: t.db,
        outboxHandlers: createOutboxHandlers({ valkey }),
        historyRetentionMonths: 24,
        historyPartitionsAhead: 3,
      }),
    });
    try {
      const [club = ""] = createTestClubs(1);
      const personId = uuidv7();
      const key = relationshipVersionKey(personId);
      const started = performance.now();
      await t.db.withTenant(asPerson(uuidv7(), club), (tx) =>
        outbox.publish(tx, "role.changed", { clubId: club, personId }),
      );
      let version: string | null = null;
      while (version === null && performance.now() - started < 5_000) {
        version = await valkey.get(key);
        if (version === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(version).toBe("1");
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(await valkey.ttl(key)).toBeGreaterThan(0);
    } finally {
      await runner.stop();
      valkey.disconnect();
    }
  });
});
