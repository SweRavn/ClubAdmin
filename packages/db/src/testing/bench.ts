// SPDX-License-Identifier: AGPL-3.0-only
// pnpm --filter @clubadmin/db bench — cost of tenant transactions and of the
// record-history trigger, on a throwaway database cloned from the test
// template (needs pnpm dev:services). Results go in docs/performance.md.

import { uuidv7 } from "@clubadmin/shared";
import { sql } from "drizzle-orm";

import { asPerson, createTestDatabase, ensureTemplate } from "./index.ts";

const ROWS = 10_000;

await ensureTemplate();
const t = await createTestDatabase();
try {
  const clubId = uuidv7();
  const context = asPerson(undefined, clubId);
  const time = async (fn: () => Promise<unknown>, runs = 1) => {
    const started = performance.now();
    for (let i = 0; i < runs; i++) await fn();
    return (performance.now() - started) / runs;
  };

  for (let i = 0; i < 50; i++) await t.db.withTenant(context, (tx) => tx.execute(sql`SELECT 1`));
  const transaction = await time(
    () => t.db.withTenant(context, (tx) => tx.execute(sql`SELECT 1`)),
    1000,
  );
  const bare = await time(() => t.db.ping(), 1000);

  for (const [table, withHistory] of [
    ["bench_plain", false],
    ["bench_history", true],
  ] as const) {
    await t.query(
      "owner",
      `CREATE TABLE public.${table} (id uuid PRIMARY KEY DEFAULT uuidv7(), club_id uuid NOT NULL, name text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
       SELECT app.enable_tenant_rls('public.${table}');
       SELECT app.enable_updated_at('public.${table}');
       ${withHistory ? `SELECT history.enable_history('public.${table}');` : ""}`,
    );
  }
  const results: Record<string, number> = {};
  for (const table of ["bench_plain", "bench_history"]) {
    results[`${table}:insert`] = await time(() =>
      t.db.withTenant(context, (tx) =>
        tx.execute(
          sql.raw(
            `INSERT INTO public.${table} (club_id, name) SELECT '${clubId}', 'row ' || g FROM generate_series(1, ${ROWS}) g`,
          ),
        ),
      ),
    );
    results[`${table}:update`] = await time(() =>
      t.db.withTenant(context, (tx) =>
        tx.execute(sql.raw(`UPDATE public.${table} SET name = name || ' changed'`)),
      ),
    );
  }
  const perRow = (key: string) => (((results[key] ?? 0) * 1000) / ROWS).toFixed(1);
  process.stdout.write(
    [
      `withTenant overhead: ${(transaction - bare).toFixed(3)} ms per transaction (bare round trip ${bare.toFixed(3)} ms)`,
      `insert ${ROWS} rows: ${results["bench_plain:insert"]?.toFixed(0)} ms without history, ${results["bench_history:insert"]?.toFixed(0)} ms with (${perRow("bench_plain:insert")} vs ${perRow("bench_history:insert")} µs/row)`,
      `update ${ROWS} rows: ${results["bench_plain:update"]?.toFixed(0)} ms without history, ${results["bench_history:update"]?.toFixed(0)} ms with (${perRow("bench_plain:update")} vs ${perRow("bench_history:update")} µs/row)`,
    ].join("\n") + "\n",
  );
} finally {
  await t.drop();
}
