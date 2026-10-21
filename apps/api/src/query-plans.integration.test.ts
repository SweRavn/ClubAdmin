// SPDX-License-Identifier: AGPL-3.0-only
// Index plan for the hot paths (docs/performance.md): "my clubs and groups",
// "members of group", "guardians of person", "wards of person". The plans
// run as the app role, with row-level security, on 10k rows per table; they
// must not scan tables sequentially. The summarised plans are snapshots, so a
// change in index use shows up in review. P0.8's load scenario reruns this at
// full size.

import type { SQLWrapper } from "@clubadmin/db";
import { sql, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import * as guardianshipQueries from "./modules/guardianships/guardianships.repository.ts";
import * as membershipQueries from "./modules/memberships/memberships.repository.ts";
import { actor } from "./testing/builders.ts";
import { useCoreDatabase } from "./testing/core.ts";

const c = useCoreDatabase();
const ROWS = 10_000;

const LOAD_SQL = `
  CREATE TEMP TABLE lp AS SELECT i, uuidv7() AS id FROM generate_series(1, ${ROWS}) i;
  CREATE TEMP TABLE lc AS SELECT i, uuidv7() AS id FROM generate_series(1, 100) i;
  CREATE TEMP TABLE lg AS SELECT i, uuidv7() AS id, (i % 100) + 1 AS club_i FROM generate_series(1, 500) i;
  INSERT INTO people (id, given_name, family_name, birth_date)
    SELECT id, 'Load', 'Person' || i, date '2005-01-01' + (i % 4000) FROM lp;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Load ' || i, 'load-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM lc;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT lc.id, lp.id, 'club_manager' FROM lc JOIN lp ON lp.i = lc.i;
  INSERT INTO club_memberships (club_id, person_id, status)
    SELECT lc.id, lp.id, 'active' FROM lp JOIN lc ON lc.i = (lp.i % 100) + 1;
  INSERT INTO groups (id, club_id, name, kind)
    SELECT lg.id, lc.id, 'G' || lg.i, 'team' FROM lg JOIN lc ON lc.i = lg.club_i;
  INSERT INTO group_memberships (club_id, group_id, person_id)
    SELECT lc.id, lg.id, lp.id FROM lp JOIN lg ON lg.i = (lp.i % 500) + 1 JOIN lc ON lc.i = lg.club_i;
  INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
    SELECT g.id, w.id, 'parent', ARRAY['act_on_behalf']
    FROM lp g JOIN lp w ON w.i = g.i + ${ROWS / 2} WHERE g.i <= ${ROWS / 2};
  CREATE TABLE public.load_ids AS
    SELECT (SELECT id FROM lp WHERE i = 42) AS person,
           (SELECT id FROM lp WHERE i = ${ROWS / 2 + 42}) AS ward,
           (SELECT id FROM lg WHERE i = 43) AS "group",
           (SELECT id FROM lc WHERE i = 44) AS club;
`;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Node type, relation and index of every node, depth first. */
function summarise(node: PlanNode, out: string[] = []): string[] {
  const parts = [node["Node Type"], node["Relation Name"], node["Index Name"]].filter(Boolean);
  out.push(parts.join(" "));
  for (const child of node.Plans ?? []) summarise(child, out);
  return out;
}

async function plan(tx: Tx, query: SQLWrapper): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query.getSQL()}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

let ids: { person: string; ward: string; group: string; club: string };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    ({
      rows: [ids],
    } = (await session.query("SELECT * FROM public.load_ids")) as unknown as {
      rows: [typeof ids];
    });
    await session.query("DROP TABLE public.load_ids");
  } finally {
    await session.end();
  }
}, 120_000);

const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => n.startsWith("Seq Scan"))).toEqual([]);

describe("query plans (10k rows)", () => {
  it("my clubs (by person, across clubs)", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(tx, membershipQueries.clubsOfPersonQuery(tx, ids.person)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("my groups (by person, across clubs)", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(tx, membershipQueries.groupsOfPersonQuery(tx, ids.person)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("members of group", async () => {
    const nodes = await c.t.db.withTenant(actor(ids.person, ids.club), (tx) =>
      plan(tx, membershipQueries.groupMembersQuery(tx, ids.club, ids.group)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("guardians of person", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(tx, guardianshipQueries.guardiansOfQuery(tx, ids.ward)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("wards of person", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(tx, guardianshipQueries.wardsOfQuery(tx, ids.person)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("the queries return the right rows through row-level security", async () => {
    const mine = await c.s.memberships.myClubsAndGroups(actor(ids.person), ids.person);
    expect(mine.clubs).toHaveLength(1);
    expect(mine.groups).toHaveLength(1);
    expect(await c.s.guardianships.wardsOf(actor(ids.person), ids.person)).toHaveLength(1);
  });
});
