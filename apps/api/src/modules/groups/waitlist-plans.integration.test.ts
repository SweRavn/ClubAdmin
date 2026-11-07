// SPDX-License-Identifier: AGPL-3.0-only
// Query plans of the waiting lists (P1.10b, docs/performance.md): the
// owners' list, the positions, the places and summary, the club managers'
// decisions, the expiry job and retention, as the app role with row-level
// security, on 10k people with 20 entries in every second of 500 groups
// (some offers past their expiry, some entries closed long ago). None may
// scan group_waitlist_entries (or another large table) sequentially.

import { sql, type SQLWrapper, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import { actor } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { ownerListQuery } from "./waitlist.repository.ts";

const c = useCoreDatabase();

const LOAD_SQL = `
  CREATE TEMP TABLE wp AS SELECT i, uuidv7() AS id FROM generate_series(1, 10000) i;
  CREATE TEMP TABLE wc AS SELECT i, uuidv7() AS id FROM generate_series(1, 100) i;
  CREATE TEMP TABLE wg AS SELECT i, uuidv7() AS id, (i % 100) + 1 AS club_i FROM generate_series(1, 500) i;
  INSERT INTO people (id, given_name, family_name, birth_date)
    SELECT id, 'Wait', 'Person' || i, date '2012-01-01' + (i % 1500) FROM wp;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Kö ' || i, 'ko-plan-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM wc;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT wc.id, wp.id, 'club_manager' FROM wc JOIN wp ON wp.i = wc.i;
  INSERT INTO groups (id, club_id, name, kind, capacity, admission_mode, waitlist_auto_offer)
    SELECT wg.id, wc.id, 'W' || wg.i, 'team', 12, 'waitlist', wg.i % 4 = 0
    FROM wg JOIN wc ON wc.i = wg.club_i;
  INSERT INTO group_memberships (club_id, group_id, person_id)
    SELECT wc.id, wg.id, wp.id FROM wp JOIN wg ON wg.i = ((wp.i - 1) % 500) + 1 JOIN wc ON wc.i = wg.club_i;
  -- 25 entries in every second group: 20 waiting, 2 offers past expiry, 3 closed long ago.
  INSERT INTO group_waitlist_entries
    (club_id, group_id, person_id, requested_by_person_id, status, queued_at, offered_at, offer_expires_at,
     closed_reason, decided_at, out_of_order_reason)
    SELECT wc.id, wg.id, wp.id, wp.id,
      CASE WHEN k <= 20 THEN 'waiting' WHEN k <= 22 THEN 'offered' ELSE 'withdrawn' END,
      now() - make_interval(days => k * 7),
      CASE WHEN k BETWEEN 21 AND 22 THEN now() - interval '8 days' END,
      CASE WHEN k BETWEEN 21 AND 22 THEN now() - interval '1 day' END,
      CASE WHEN k > 22 THEN 'withdrawn' END,
      CASE WHEN k > 20 THEN now() - make_interval(months => k - 8) END,
      CASE WHEN k = 21 THEN 'Sibling' END
    FROM wg JOIN wc ON wc.i = wg.club_i
    CROSS JOIN generate_series(1, 25) k
    JOIN wp ON wp.i = ((wg.i * 25 + k) % 10000) + 1
    WHERE wg.i % 2 = 0;
  CREATE TABLE public.waitlist_plan_ids AS
    SELECT (SELECT id FROM wg WHERE i = 42) AS "group",
           (SELECT id FROM wc WHERE i = 43) AS club,
           (SELECT id FROM wp WHERE i = 43) AS manager,
           (SELECT array_agg(e.id) FROM group_waitlist_entries e
             JOIN wg ON wg.id = e.group_id WHERE wg.i = 42) AS entries;
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

async function plan(tx: Tx, query: SQLWrapper): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query.getSQL()}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

/** Small tables (one club, one group row): a scan is the right plan there. */
const LARGE = ["group_waitlist_entries", "group_memberships", "people", "groups", "join_requests"];
const noLargeSeqScan = (nodes: string[]) =>
  expect(
    nodes.filter((n) => n.startsWith("Seq Scan") && LARGE.some((t) => n === `Seq Scan ${t}`)),
  ).toEqual([]);

let ids: { group: string; club: string; manager: string; entries: string[] };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    const { rows } = (await session.query("SELECT * FROM public.waitlist_plan_ids")) as unknown as {
      rows: [typeof ids];
    };
    ids = rows[0];
    await session.query("DROP TABLE public.waitlist_plan_ids");
  } finally {
    await session.end();
  }
}, 120_000);

describe("waiting-list query plans (P1.10b)", () => {
  const tenant = () => actor(ids.manager, ids.club);

  it("the owners' list (open, in order) uses the order index", async () => {
    const nodes = await c.t.db.withTenant(tenant(), (tx) =>
      plan(
        tx,
        ownerListQuery(
          ids.group,
          { status: "open", birthYear: null, fitsGender: false, limit: 51 },
          null,
        ),
      ),
    );
    noLargeSeqScan(nodes);
    expect(nodes.join("\n")).toMatch(/group_waitlist_entries_(order_idx|open_unique)/);
  });

  it("the owners' recently closed entries", async () => {
    const nodes = await c.t.db.withTenant(tenant(), (tx) =>
      plan(
        tx,
        ownerListQuery(
          ids.group,
          { status: "closed", birthYear: null, fitsGender: false, limit: 51 },
          null,
        ),
      ),
    );
    noLargeSeqScan(nodes);
  });

  it("positions of entries (the body of app.waitlist_positions)", async () => {
    const nodes = await c.t.db.withTenant(tenant(), (tx) =>
      plan(
        tx,
        sql`SELECT e.id,
              (SELECT count(*) FROM public.group_waitlist_entries o
               WHERE o.group_id = e.group_id AND o.status = 'waiting'
                 AND (o.priority > e.priority OR (o.priority = e.priority AND (o.queued_at, o.id) < (e.queued_at, e.id)))),
              (SELECT count(*) FROM public.group_waitlist_entries w WHERE w.group_id = e.group_id AND w.status = 'waiting')
            FROM public.group_waitlist_entries e
            WHERE e.id = ANY (${sql`ARRAY[${sql.join(
              ids.entries.slice(0, 3).map((id) => sql`${id}`),
              sql`, `,
            )}]::uuid[]`})`,
      ),
    );
    noLargeSeqScan(nodes);
  });

  it("the places of a group (the body of app.group_places) and the summary", async () => {
    const nodes = await c.t.db.withTenant(tenant(), (tx) =>
      plan(
        tx,
        sql`SELECT
              (SELECT count(*) FROM public.group_memberships gm
               WHERE gm.club_id = g.club_id AND gm.group_id = g.id AND gm.valid_to IS NULL AND gm.function = 'member'),
              (SELECT count(*) FROM public.group_waitlist_entries w
               WHERE w.group_id = g.id AND w.status IN ('offered', 'accepted')),
              (SELECT count(*) FROM public.group_waitlist_entries w
               WHERE w.group_id = g.id AND w.status IN ('waiting', 'offered', 'accepted'))
            FROM public.groups g WHERE g.id = ${ids.group}`,
      ),
    );
    noLargeSeqScan(nodes);
  });

  it("the club managers' out-of-turn decisions", async () => {
    const nodes = await c.t.db.withTenant(tenant(), (tx) =>
      plan(
        tx,
        sql`SELECT e.id, e.decided_at FROM public.group_waitlist_entries e
            WHERE e.club_id = ${ids.club} AND e.out_of_order_reason IS NOT NULL
              AND e.decided_at >= now() - interval '1 year'
            UNION ALL
            SELECT m.id, m.created_at FROM public.group_memberships m
            WHERE m.club_id = ${ids.club} AND m.queue_bypass_reason IS NOT NULL
              AND m.created_at >= now() - interval '1 year'
            ORDER BY 2 DESC LIMIT 51`,
      ),
    );
    noLargeSeqScan(nodes);
    expect(nodes.join("\n")).toContain("group_waitlist_entries_out_of_order_idx");
  });

  it("the expiry job (waitlists:offers) and retention (joining:retention)", async () => {
    const expire = await c.t.db.withSystem("test", { clubId: ids.club }, (tx) =>
      plan(
        tx,
        sql`UPDATE public.group_waitlist_entries SET status = 'expired'
            WHERE club_id = ${ids.club} AND status = 'offered' AND offer_expires_at <= now()`,
      ),
    );
    noLargeSeqScan(expire);
    expect(expire.join("\n")).toContain("group_waitlist_entries_offers_idx");
    const retention = await c.t.db.withSystem("test", { clubId: ids.club }, (tx) =>
      plan(
        tx,
        sql`DELETE FROM public.group_waitlist_entries
            WHERE club_id = ${ids.club} AND status NOT IN ('waiting', 'offered', 'accepted')
              AND coalesce(decided_at, updated_at) < now() - interval '12 months'`,
      ),
    );
    noLargeSeqScan(retention);
    expect(retention.join("\n")).toContain("group_waitlist_entries_closed_idx");
  });

  it("finds the clubs with work for waitlists:offers", async () => {
    const nodes = await c.t.db.withSystem("test", {}, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.lookup', 'waitlist_offers', true)`);
      return plan(
        tx,
        sql`SELECT e.club_id FROM public.group_waitlist_entries e
            WHERE e.status = 'offered' AND e.offer_expires_at <= now()
            UNION
            SELECT g.club_id FROM public.groups g
            WHERE g.waitlist_auto_offer AND g.archived_at IS NULL AND g.admission_mode = 'waitlist'
              AND EXISTS (SELECT 1 FROM public.group_waitlist_entries w
                          WHERE w.group_id = g.id AND w.status = 'waiting')`,
      );
    });
    noLargeSeqScan(nodes);
  });
});
