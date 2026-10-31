// SPDX-License-Identifier: AGPL-3.0-only
// The budgets of the inbox (P1.7, docs/performance.md) on 20,000 recipients
// with 25 notices each (500,000 rows) and one heavy recipient with 3,000:
// the inbox page, its next page, the unread filter, the unread count and
// "mark all as read" use the recipient's indexes (no sequential scan), and
// the first page and the count answer within the 50 ms budget as the app
// role with row-level security.

import { type SQL, sql, type Tx } from "@clubadmin/db";
import { UNREAD_COUNT_CAP } from "@clubadmin/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { actor } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { inboxQuery, unreadCountQuery } from "./notifications.repository.ts";
import { INBOX_PAGE_SIZE } from "./notifications.service.ts";

const c = useCoreDatabase();
const RECIPIENTS = 20_000;
const PER_RECIPIENT = 25;
const HEAVY = 3_000;

const LOAD_SQL = `
  CREATE TEMP TABLE np AS SELECT i, uuidv7() AS id FROM generate_series(1, ${RECIPIENTS}) i;
  INSERT INTO people (id, given_name, family_name, birth_date)
    SELECT id, 'Förälder', 'Nummer' || i, date '1980-01-01' + (i % 5000) FROM np;
  INSERT INTO notifications (id, recipient_person_id, category, type, subject_type, params, dedupe_key,
                             read_at, created_at)
    SELECT uuidv7(-make_interval(hours => k * 80, secs => np.i)), np.id,
      CASE WHEN k % 3 = 0 THEN 'responses' ELSE 'schedule' END,
      CASE WHEN k % 3 = 0 THEN 'response.reminder' ELSE 'activity.cancelled' END,
      'activity', '{"title": "Träning"}'::jsonb, 'plan:' || np.i || ':' || k,
      CASE WHEN k > 2 THEN now() - make_interval(hours => k * 80 - 1) END,
      now() - make_interval(hours => k * 80, secs => np.i)
    FROM np CROSS JOIN generate_series(0, ${PER_RECIPIENT - 1}) k;
  -- One recipient with many notices, a third of them unread.
  INSERT INTO notifications (id, recipient_person_id, category, type, subject_type, params, dedupe_key,
                             read_at, created_at)
    SELECT uuidv7(-make_interval(mins => k * 40)), (SELECT id FROM np WHERE i = 1),
      'schedule', 'activity.moved', 'activity', '{"title": "Träning"}'::jsonb, 'heavy:' || k,
      CASE WHEN k % 3 <> 0 THEN now() END, now() - make_interval(mins => k * 40)
    FROM generate_series(1, ${HEAVY}) k;
  CREATE TABLE public.notification_plan_ids AS
    SELECT (SELECT id FROM np WHERE i = 1) AS heavy, (SELECT id FROM np WHERE i = ${RECIPIENTS / 2}) AS typical;
`;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function summarise(node: PlanNode, out: string[] = []): string[] {
  out.push(
    [node["Node Type"], node["Relation Name"], node["Index Name"]].filter(Boolean).join(" "),
  );
  for (const child of node.Plans ?? []) summarise(child, out);
  return out;
}

async function plan(tx: Tx, query: SQL | { getSQL(): SQL }): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

/** Rows the executor looked at (returned plus removed by filters), from EXPLAIN ANALYZE. */
async function rowsRead(tx: Tx, query: SQL | { getSQL(): SQL }): Promise<number> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: AnalyzedNode }] }>(
    sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
  );
  const count = (node: AnalyzedNode): number =>
    (node.Plans ? 0 : (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) +
    (node.Plans ?? []).reduce((sum, child) => sum + count(child), 0);
  return count(rows[0]!["QUERY PLAN"][0].Plan);
}

interface AnalyzedNode {
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: AnalyzedNode[];
}

const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => n.startsWith("Seq Scan notifications"))).toEqual([]);
const uses = (nodes: string[], index: string) =>
  expect(
    nodes.some((n) => n.includes(index)),
    nodes.join(" / "),
  ).toBe(true);

let ids: { heavy: string; typical: string };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    ({
      rows: [ids],
    } = (await session.query("SELECT * FROM public.notification_plan_ids")) as unknown as {
      rows: [typeof ids];
    });
    await session.query("DROP TABLE public.notification_plan_ids");
  } finally {
    await session.end();
  }
}, 300_000);

const page = (options: { cursor?: string; unread?: boolean } = {}) =>
  ({
    cursor: options.cursor,
    unread: options.unread ?? false,
    limit: INBOX_PAGE_SIZE + 1,
  }) as const;

describe(`inbox plans (${RECIPIENTS * PER_RECIPIENT + HEAVY} notices)`, () => {
  it("a typical inbox: the first page, the next page and the unread filter use the inbox index", async () => {
    const personId = ids.typical;
    await c.t.db.withActor(actor(personId), async (tx) => {
      const first = await plan(tx, inboxQuery(tx, personId, page()));
      noSeqScan(first);
      uses(first, "notifications_inbox_idx");
      const rows = await inboxQuery(tx, personId, page());
      const cursor = rows.at(-1)!.id;
      const next = await plan(tx, inboxQuery(tx, personId, page({ cursor })));
      noSeqScan(next);
      uses(next, "notifications_inbox_idx");
      const unread = await plan(tx, inboxQuery(tx, personId, page({ unread: true })));
      noSeqScan(unread);
      expect(
        unread.some((n) => /notifications_(inbox|unread)_idx/.test(n)),
        unread.join(" / "),
      ).toBe(true);
    });
  });

  // Thousands of recent notices: walking the primary key backwards can be the
  // cheaper plan; either way a page reads a small part of the table.
  it("a heavy inbox reads a small part of the table per page", async () => {
    const personId = ids.heavy;
    await c.t.db.withActor(actor(personId), async (tx) => {
      const rows = await inboxQuery(tx, personId, page());
      for (const options of [{}, { cursor: rows.at(-1)!.id }, { unread: true }]) {
        const query = inboxQuery(tx, personId, page(options));
        noSeqScan(await plan(tx, query));
        expect(await rowsRead(tx, query)).toBeLessThan(25_000);
      }
    });
  });

  it("the unread count stops at the cap on the partial index", async () => {
    await c.t.db.withActor(actor(ids.heavy), async (tx) => {
      const nodes = await plan(tx, unreadCountQuery(ids.heavy, UNREAD_COUNT_CAP));
      noSeqScan(nodes);
      uses(nodes, "notifications_unread_idx");
      const { rows } = await tx.execute<{ n: number }>(
        unreadCountQuery(ids.heavy, UNREAD_COUNT_CAP),
      );
      expect(rows[0]?.n).toBe(UNREAD_COUNT_CAP);
    });
  });

  it("marking all as read touches only the recipient's unread rows", async () => {
    await c.t.db.withActor(actor(ids.heavy), async (tx) => {
      const [newest] = await inboxQuery(tx, ids.heavy, page());
      const nodes = await plan(
        tx,
        sql`UPDATE public.notifications SET read_at = now()
          WHERE recipient_person_id = ${ids.heavy} AND read_at IS NULL AND id <= ${newest!.id}`,
      );
      noSeqScan(nodes);
    });
  });

  // The budget is 50 ms (docs/performance.md); shared CI runners get a margin.
  it("answers the first page and the count within the budget", async () => {
    const timings: number[] = [];
    for (let run = 0; run < 22; run++) {
      const started = performance.now();
      await c.t.db.withActor(actor(ids.heavy), async (tx) => {
        await inboxQuery(tx, ids.heavy, page());
        await tx.execute(unreadCountQuery(ids.heavy, UNREAD_COUNT_CAP));
      });
      if (run >= 2) timings.push(performance.now() - started);
    }
    const p95 = Math.round(timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.95) - 1]!);
    expect(p95, `p95 ${p95} ms`).toBeLessThan(75);
  });
});
