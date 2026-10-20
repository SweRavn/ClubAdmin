// SPDX-License-Identifier: AGPL-3.0-only
import { uuidv7 } from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRecordHistory } from "./history.ts";
import { createSampleTable, SAMPLE_TABLE } from "./testing/fixtures.ts";
import {
  asPerson,
  createTestClubs,
  createTestDatabase,
  type TestDatabase,
} from "./testing/index.ts";

let t: TestDatabase;
const [club = ""] = createTestClubs(1);
const anna = uuidv7();
const elsa = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  await createSampleTable(t);
});
afterAll(async () => {
  await t.drop();
});

async function insertItem(name = "Item", secret = "s3cret"): Promise<string> {
  return t.db.withTenant(asPerson(anna, club), async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.test_items (club_id, name, secret) VALUES (${club}, ${name}, ${secret}) RETURNING id`,
    );
    return r.rows[0]?.id ?? "";
  });
}

const historyOf = (id: string) =>
  t
    .query<Record<string, unknown>>(
      "admin",
      "SELECT * FROM history.record_changes WHERE record_id = $1 ORDER BY changed_at, id",
      [id],
    )
    .then((r) => r.rows);

describe("record history", () => {
  it("records an update with only the changed column, the actor, on-behalf-of and request id", async () => {
    const id = await insertItem();
    await t.db.withTenant(asPerson(anna, club, { onBehalfOf: elsa, requestId: "req-123" }), (tx) =>
      tx.execute(sql`UPDATE public.test_items SET name = 'Renamed' WHERE id = ${id}`),
    );
    const rows = await historyOf(id);
    expect(rows.map((r) => r.operation)).toEqual(["INSERT", "UPDATE"]);
    expect(rows[1]).toMatchObject({
      table_name: SAMPLE_TABLE,
      club_id: club,
      changed_columns: ["name"],
      old_values: { name: "Item" },
      new_values: { name: "Renamed" },
      actor_person_id: anna,
      on_behalf_of_person_id: elsa,
      actor_kind: "person",
      request_id: "req-123",
      db_role: "clubadmin_app",
    });
  });

  it("stores redacted columns as [changed], also on insert and delete", async () => {
    const id = await insertItem("Redacted", "very secret");
    await t.db.withTenant(asPerson(anna, club), async (tx) => {
      await tx.execute(
        sql`UPDATE public.test_items SET secret = 'even more secret' WHERE id = ${id}`,
      );
      await tx.execute(sql`DELETE FROM public.test_items WHERE id = ${id}`);
    });
    const rows = await historyOf(id);
    expect(rows.map((r) => r.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(rows[0]?.new_values).toMatchObject({ name: "Redacted", secret: "[changed]" });
    expect(rows[1]).toMatchObject({
      changed_columns: ["secret"],
      old_values: { secret: "[changed]" },
      new_values: { secret: "[changed]" },
    });
    expect(rows[2]?.old_values).toMatchObject({ name: "Redacted", secret: "[changed]" });
    expect(rows[2]?.new_values).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("secret'");
    expect(JSON.stringify(rows)).not.toContain("very secret");
  });

  it("writes nothing when no column except updated_at changes", async () => {
    const id = await insertItem("Same");
    await t.db.withTenant(asPerson(anna, club), (tx) =>
      tx.execute(sql`UPDATE public.test_items SET name = 'Same' WHERE id = ${id}`),
    );
    expect((await historyOf(id)).map((r) => r.operation)).toEqual(["INSERT"]);
  });

  it("records changes made without context as db_role", async () => {
    const id = await insertItem("Direct");
    await t.query("admin", "UPDATE public.test_items SET name = 'Fixed by hand' WHERE id = $1", [
      id,
    ]);
    const last = (await historyOf(id)).at(-1);
    expect(last).toMatchObject({
      actor_kind: "db_role",
      db_role: "postgres",
      actor_person_id: null,
    });
  });

  it("records background jobs as system_job with the job name", async () => {
    const id = await insertItem("Job");
    await t.db.withSystem("test.cleanup", { clubId: club }, (tx) =>
      tx.execute(sql`UPDATE public.test_items SET name = 'Cleaned' WHERE id = ${id}`),
    );
    expect((await historyOf(id)).at(-1)).toMatchObject({
      actor_kind: "system_job",
      request_id: "job:test.cleanup",
    });
  });

  it("pages through a record's history, newest first, within the current club only", async () => {
    const id = await insertItem("v0");
    for (let i = 1; i <= 5; i++) {
      await t.db.withTenant(asPerson(anna, club), (tx) =>
        tx.execute(sql`UPDATE public.test_items SET name = ${`v${i}`} WHERE id = ${id}`),
      );
    }
    const names: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await t.db.withTenant(asPerson(anna, club), (tx) =>
        getRecordHistory(tx, SAMPLE_TABLE, id, { cursor, limit: 2 }),
      );
      names.push(...page.items.map((c) => c.newValues?.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(names).toEqual(["v5", "v4", "v3", "v2", "v1", "v0"]);

    const [otherClub = ""] = createTestClubs(1);
    const other = await t.db.withTenant(asPerson(anna, otherClub), (tx) =>
      getRecordHistory(tx, SAMPLE_TABLE, id),
    );
    expect(other.items).toEqual([]);
  });

  it("requires operators to identify themselves", async () => {
    await t.query("admin", "GRANT clubadmin_operator TO postgres").catch(() => undefined);
    const id = await insertItem("Operator");
    await expect(
      t.query(
        "operator",
        `SELECT set_config('app.club_id', '${club}', false); UPDATE public.test_items SET name = 'x' WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/must set app.actor_kind/);
    await t.query(
      "operator",
      `SELECT set_config('app.club_id', '${club}', false), set_config('app.actor_kind', 'operator', false),
              set_config('app.person_id', '${anna}', false);
       UPDATE public.test_items SET name = 'support fix' WHERE id = '${id}'`,
    );
    expect((await historyOf(id)).at(-1)).toMatchObject({
      actor_kind: "operator",
      db_role: "clubadmin_operator",
    });
  });
});

describe("history partitions", () => {
  it("creates future partitions and moves rows out of the default partition", async () => {
    // A row far in the future lands in the default partition…
    await t.query(
      "owner",
      `INSERT INTO history.record_changes (changed_at, table_name, record_id, operation, changed_columns, actor_kind, transaction_id, db_role)
       VALUES (date_trunc('month', now()) + interval '8 months', 'public.x', uuidv7(), 'INSERT', '{}', 'db_role', 1, 'test')`,
    );
    const before = await t.query(
      "admin",
      "SELECT count(*)::int AS n FROM history.record_changes_default",
    );
    expect(before.rows[0]).toEqual({ n: 1 });

    // …and is moved when maintenance creates that month's partition.
    const result = await t.query<{ action: string; partition_name: string }>(
      "app",
      "SELECT * FROM history.maintain_partitions(9, 24)",
    );
    // Months 0–3 exist since the migration; 4–9 are new.
    expect(result.rows.filter((r) => r.action === "created")).toHaveLength(6);
    const after = await t.query(
      "admin",
      "SELECT count(*)::int AS n FROM history.record_changes_default",
    );
    expect(after.rows[0]).toEqual({ n: 0 });
    const moved = await t.query(
      "admin",
      "SELECT count(*)::int AS n FROM history.record_changes WHERE table_name = 'public.x'",
    );
    expect(moved.rows[0]).toEqual({ n: 1 });
  });

  it("drops partitions older than the retention period", async () => {
    await t.query(
      "owner",
      `CREATE TABLE history.record_changes_2020_01 PARTITION OF history.record_changes
       FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')`,
    );
    const result = await t.query<{ action: string; partition_name: string }>(
      "app",
      "SELECT * FROM history.maintain_partitions(3, 24)",
    );
    expect(result.rows).toContainEqual({
      action: "dropped",
      partition_name: "record_changes_2020_01",
    });
  });
});
