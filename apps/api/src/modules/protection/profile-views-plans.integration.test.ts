// SPDX-License-Identifier: AGPL-3.0-only
// The club's profile view log on volume (P1.12, docs/performance.md): a club
// that logs every view, 100,000 rows over 5,000 members (20,000 of them
// views of protected members) in a database with other clubs' rows. The
// club log, its filters and a person's log use their indexes (no sequential
// scan of profile_views), and a page of 50 answers within 100 ms.

import { type SQL, sql, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import { useCoreDatabase } from "../../testing/core.ts";
import { clubLogQuery } from "./protection.repository.ts";

const c = useCoreDatabase();
const MEMBERS = 5_000;
const ROWS = 100_000;

const LOAD_SQL = `
  CREATE TEMP TABLE vc AS SELECT i, uuidv7() AS id FROM generate_series(1, 3) i;
  CREATE TEMP TABLE vp AS SELECT i, uuidv7() AS id FROM generate_series(1, ${MEMBERS}) i;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency, profile_view_logging)
    SELECT id, 'Vy ' || i, 'views-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', 'all' FROM vc;
  INSERT INTO people (id, given_name, family_name) SELECT id, 'Medlem', 'Nr' || i FROM vp;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT vc.id, (SELECT id FROM vp WHERE i = 1), 'club_manager' FROM vc;
  INSERT INTO profile_views (club_id, viewed_person_id, viewer_person_id, viewer_kind, surface,
      protected, day, first_viewed_at, last_viewed_at)
    SELECT vc.id, viewed.id, viewer.id, 'person', 'profile', k % 5 = 0,
      (timestamptz '2026-10-01' - make_interval(mins => k))::date,
      timestamptz '2026-10-01' - make_interval(mins => k),
      timestamptz '2026-10-01' - make_interval(mins => k)
    FROM generate_series(1, ${ROWS}) k
    JOIN vc ON vc.i = 1 + (k % 3)
    JOIN vp viewed ON viewed.i = 1 + (k % ${MEMBERS})
    JOIN vp viewer ON viewer.i = 1 + ((k * 7) % ${MEMBERS});
  CREATE TABLE public.view_ids AS
    SELECT (SELECT id FROM vc WHERE i = 1) AS club, (SELECT id FROM vp WHERE i = 42) AS person;
`;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
const summarise = (node: PlanNode, out: string[] = []): string[] => {
  out.push([node["Node Type"], node["Relation Name"]].filter(Boolean).join(" "));
  for (const child of node.Plans ?? []) summarise(child, out);
  return out;
};
async function plan(tx: Tx, query: SQL): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

let ids: { club: string; person: string };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    ({
      rows: [ids],
    } = (await session.query("SELECT * FROM public.view_ids")) as unknown as {
      rows: [typeof ids];
    });
    await session.query("DROP TABLE public.view_ids");
  } finally {
    await session.end();
  }
}, 300_000);

describe("the profile view log on volume", () => {
  it("reads the club's log, its filters and a person's log through indexes", async () => {
    await c.t.db.withSystem("test:plans", { clubId: ids.club }, async (tx) => {
      for (const query of [
        clubLogQuery(ids.club, {}, 51),
        clubLogQuery(ids.club, { protected: "only" }, 51),
        clubLogQuery(ids.club, { personId: ids.person }, 51),
        clubLogQuery(ids.club, { viewerId: ids.person }, 51),
        sql`SELECT * FROM public.profile_views v WHERE v.viewed_person_id = ${ids.person}
            ORDER BY v.last_viewed_at DESC, v.id DESC LIMIT 51`,
      ]) {
        const nodes = await plan(tx, query);
        expect(nodes.filter((n) => n === "Seq Scan profile_views")).toEqual([]);
      }
      const started = performance.now();
      await tx.execute(clubLogQuery(ids.club, {}, 51));
      expect(performance.now() - started).toBeLessThan(100);
    });
  });
});
