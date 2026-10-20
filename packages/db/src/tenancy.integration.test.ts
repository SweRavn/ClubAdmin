// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSampleTable } from "./testing/fixtures.ts";
import {
  asPerson,
  createTestClubs,
  createTestDatabase,
  expectTenantIsolation,
  type TestDatabase,
} from "./testing/index.ts";

let t: TestDatabase;
const [clubA = "", clubB = ""] = createTestClubs(2);

beforeAll(async () => {
  t = await createTestDatabase();
  await createSampleTable(t);
});
afterAll(async () => {
  await t.drop();
});

describe("tenant isolation (row-level security)", () => {
  it("hides, and protects from changes, another club's rows", async () => {
    const id = await t.db.withTenant(asPerson(undefined, clubA), async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO public.test_items (club_id, name) VALUES (${clubA}, 'A item') RETURNING id`,
      );
      return result.rows[0]?.id ?? "";
    });

    const seenByA = await t.db.withTenant(asPerson(undefined, clubA), (tx) =>
      tx.execute(sql`SELECT * FROM public.test_items`),
    );
    expect(seenByA.rows).toHaveLength(1);

    await expectTenantIsolation(t.db, clubB, (tx) =>
      tx.execute(sql`SELECT * FROM public.test_items`),
    );
    await expectTenantIsolation(t.db, clubB, (tx) =>
      tx.execute(sql`UPDATE public.test_items SET name = 'hacked' WHERE id = ${id}`),
    );
    await expectTenantIsolation(t.db, clubB, (tx) =>
      tx.execute(sql`DELETE FROM public.test_items WHERE id = ${id}`),
    );

    const after = await t.db.withTenant(asPerson(undefined, clubA), (tx) =>
      tx.execute<{ name: string }>(sql`SELECT name FROM public.test_items WHERE id = ${id}`),
    );
    expect(after.rows).toEqual([{ name: "A item" }]);
  });

  it("refuses to write a row for another club", async () => {
    await expect(
      t.db.withTenant(asPerson(undefined, clubA), (tx) =>
        tx.execute(
          sql`INSERT INTO public.test_items (club_id, name) VALUES (${clubB}, 'smuggled')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows nothing without a club context", async () => {
    const rows = await t.db.withActor({ actorKind: "anonymous" }, (tx) =>
      tx.execute(sql`SELECT * FROM public.test_items`),
    );
    expect(rows.rows).toEqual([]);
  });

  it("does not leak settings between transactions (pooled connections)", async () => {
    await t.db.withTenant(asPerson(undefined, clubA), (tx) => tx.execute(sql`SELECT 1`));
    const settings = await t.db.withActor({ actorKind: "anonymous" }, (tx) =>
      tx.execute<{ club: string | null }>(sql`SELECT app.current_club_id()::text AS club`),
    );
    expect(settings.rows[0]?.club).toBeNull();
  });

  it("validates the context", async () => {
    await expect(
      t.db.withTenant({ actorKind: "person", clubId: clubA }, () => Promise.resolve()),
    ).rejects.toThrow(/requires personId/);
    await expect(
      t.db.withTenant(asPerson(undefined, "not-a-uuid"), () => Promise.resolve()),
    ).rejects.toThrow(/UUID/);
  });

  it("adds little overhead per transaction", async () => {
    const context = asPerson(undefined, clubA);
    const measure = async (fn: () => Promise<unknown>, runs = 200) => {
      for (let i = 0; i < 20; i++) await fn(); // warm up
      const started = performance.now();
      for (let i = 0; i < runs; i++) await fn();
      return (performance.now() - started) / runs;
    };
    const transaction = await measure(() =>
      t.db.withTenant(context, (tx) => tx.execute(sql`SELECT 1`)),
    );
    const bare = await measure(() => t.db.ping());
    console.info(`withTenant overhead: ${(transaction - bare).toFixed(3)} ms per transaction`);
    // Budget: < 1 ms locally (docs/performance.md); generous here because test files run in parallel.
    expect(transaction - bare).toBeLessThan(5);
  });
});
