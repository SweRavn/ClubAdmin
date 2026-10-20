// SPDX-License-Identifier: AGPL-3.0-only
import { uuidv7 } from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { audit } from "./audit.ts";
import { outbox, type OutboxHandler } from "./outbox.ts";
import {
  asPerson,
  createTestClubs,
  createTestDatabase,
  type TestDatabase,
} from "./testing/index.ts";

let t: TestDatabase;
const [club = ""] = createTestClubs(1);
const anna = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  // A table a handler writes to, to observe exactly-once database effects.
  await t.query(
    "owner",
    `CREATE TABLE public.test_effects (id uuid PRIMARY KEY DEFAULT uuidv7(), event_id uuid NOT NULL);
     SELECT history.enable_history('public.test_effects');`,
  );
});
afterAll(async () => {
  await t.drop();
});

describe("audit events", () => {
  it("records the action with club, actor, request and changed field names", async () => {
    const resourceId = uuidv7();
    await t.db.withTenant(
      asPerson(anna, club, { requestId: "req-audit", ipHash: "abc123" }),
      (tx) =>
        audit.record(tx, {
          action: "group.owner.added",
          resourceType: "group",
          resourceId,
          changedFields: ["owner"],
        }),
    );
    const { rows } = await t.query("admin", "SELECT * FROM audit.events WHERE resource_id = $1", [
      resourceId,
    ]);
    expect(rows[0]).toMatchObject({
      club_id: club,
      actor_person_id: anna,
      actor_kind: "person",
      action: "group.owner.added",
      changed_fields: ["owner"],
      ip_hash: "abc123",
      request_id: "req-audit",
    });
  });

  it("cannot be changed or deleted by the app role, only by retention", async () => {
    await expect(t.query("app", "UPDATE audit.events SET action = 'x.y'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(t.query("app", "DELETE FROM audit.events")).rejects.toThrow(/permission denied/);
    await expect(t.query("app", "DELETE FROM history.record_changes")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      t.query("app", "UPDATE history.record_changes SET actor_kind = 'x'"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.query(
        "app",
        "INSERT INTO history.record_changes (table_name, record_id, operation, changed_columns, actor_kind, transaction_id, db_role) VALUES ('x', uuidv7(), 'INSERT', '{}', 'x', 1, 'x')",
      ),
    ).rejects.toThrow(/permission denied/);
    const deleted = await t.query("retention", "DELETE FROM audit.events");
    expect(deleted.rowCount).toBeGreaterThan(0);
  });
});

const jobsFor = (eventId: string) =>
  t
    .query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = $1",
      [`outbox:${eventId}`],
    )
    .then((r) => r.rows[0]?.n);

describe("outbox", () => {
  it("never dispatches an event from a rolled-back transaction", async () => {
    let eventId = "";
    await expect(
      t.db.withTenant(asPerson(anna, club), async (tx) => {
        eventId = await outbox.publish(tx, "membership.changed", { clubId: club, personId: anna });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    const events = await t.query("admin", "SELECT * FROM outbox.events WHERE id = $1", [eventId]);
    expect(events.rows).toEqual([]);
    expect(await jobsFor(eventId)).toBe(0);
  });

  it("enqueues a dispatch job for a committed event", async () => {
    const eventId = await t.db.withTenant(asPerson(anna, club), (tx) =>
      outbox.publish(tx, "membership.changed", { clubId: club, personId: anna }),
    );
    expect(await jobsFor(eventId)).toBe(1);
    const { rows } = await t.query(
      "admin",
      "SELECT type, club_id, payload, status FROM outbox.events WHERE id = $1",
      [eventId],
    );
    expect(rows[0]).toEqual({
      type: "membership.changed",
      club_id: club,
      payload: { clubId: club, personId: anna },
      status: "pending",
    });
  });

  it("rejects payloads that do not match the event schema", async () => {
    await expect(
      t.db.withTenant(asPerson(anna, club), (tx) =>
        // @ts-expect-error: name is not part of the payload (IDs only)
        outbox.publish(tx, "membership.changed", { clubId: club, personId: anna, name: "Anna" }),
      ),
    ).resolves.toBeDefined(); // unknown keys are stripped…
    const { rows } = await t.query(
      "admin",
      "SELECT payload FROM outbox.events ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]?.payload).toEqual({ clubId: club, personId: anna }); // …so names never reach the outbox
    await expect(
      t.db.withTenant(asPerson(anna, club), (tx) =>
        outbox.publish(tx, "membership.changed", { clubId: "nope", personId: anna }),
      ),
    ).rejects.toThrow();
  });

  it("runs each handler exactly once, also when a dispatch fails half-way and is retried", async () => {
    const eventId = await t.db.withTenant(asPerson(anna, club), (tx) =>
      outbox.publish(tx, "membership.changed", { clubId: club, personId: anna }),
    );
    let calls = 0;
    let crash = true;
    const handler: OutboxHandler = {
      name: "test.effects",
      types: ["membership.changed"],
      async handle(event, tx) {
        calls++;
        await tx.execute(sql`INSERT INTO public.test_effects (event_id) VALUES (${event.id})`);
        if (crash) throw new Error("worker died"); // after the effect, before the delivery record
      },
    };
    await expect(outbox.dispatch(t.db, eventId, [handler])).rejects.toThrow("worker died");
    await outbox.recordFailure(t.db, eventId, new Error("worker died"), false);

    crash = false;
    expect(await outbox.dispatch(t.db, eventId, [handler])).toBe("dispatched");
    expect(await outbox.dispatch(t.db, eventId, [handler])).toBe("already-done");

    const effects = await t.query(
      "admin",
      "SELECT count(*)::int AS n FROM public.test_effects WHERE event_id = $1",
      [eventId],
    );
    expect(effects.rows[0]).toEqual({ n: 1 }); // the failed attempt's effect was rolled back
    expect(calls).toBe(2);
    const { rows } = await t.query(
      "admin",
      "SELECT status, attempts, last_error FROM outbox.events WHERE id = $1",
      [eventId],
    );
    expect(rows[0]).toMatchObject({
      status: "done",
      attempts: 2,
      last_error: "Error: worker died",
    });
  });

  it("marks events failed permanently", async () => {
    const eventId = await t.db.withTenant(asPerson(anna, club), (tx) =>
      outbox.publish(tx, "role.changed", { clubId: club, personId: anna }),
    );
    await outbox.recordFailure(t.db, eventId, new Error("still broken"), true);
    const { rows } = await t.query("admin", "SELECT status FROM outbox.events WHERE id = $1", [
      eventId,
    ]);
    expect(rows[0]).toEqual({ status: "failed" });
  });
});
