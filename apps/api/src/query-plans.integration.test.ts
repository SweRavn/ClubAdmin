// SPDX-License-Identifier: AGPL-3.0-only
// Index plan for the hot paths (docs/performance.md): "my clubs and groups",
// "members of group", "guardians of person", "wards of person", and (P0.7)
// the relationship set, a roster page and a club's protected set. The plans
// run as the app role, with row-level security, on 10k rows per table; they
// must not scan tables sequentially. The summarised plans are snapshots, so a
// change in index use shows up in review. P0.8's load scenario reruns this at
// full size. P1.1 adds the club's join requests and "my join requests".

import type { SQLWrapper } from "@clubadmin/db";
import { sql, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import * as authorizationQueries from "./modules/authorization/authorization.repository.ts";
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
  INSERT INTO people (id, given_name, family_name, birth_date, protected_identity)
    SELECT id, 'Load', 'Person' || i, date '2005-01-01' + (i % 4000), i % 1000 = 0 FROM lp;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Load ' || i, 'load-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM lc;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT lc.id, lp.id, 'club_manager' FROM lc JOIN lp ON lp.i = lc.i;
  INSERT INTO club_memberships (club_id, person_id, status)
    SELECT lc.id, lp.id, 'active' FROM lp JOIN lc ON lc.i = (lp.i % 100) + 1;
  INSERT INTO club_profiles (club_id, person_id, member_number, protected_identity_club)
    SELECT lc.id, lp.id, lp.i, lp.i % 997 = 0 FROM lp JOIN lc ON lc.i = (lp.i % 100) + 1;
  INSERT INTO groups (id, club_id, name, kind)
    SELECT lg.id, lc.id, 'G' || lg.i, 'team' FROM lg JOIN lc ON lc.i = lg.club_i;
  -- Each person in a group of their own club (group members are club members).
  INSERT INTO group_memberships (club_id, group_id, person_id)
    SELECT lc.id, lg.id, lp.id FROM lp JOIN lg ON lg.i = ((lp.i - 1) % 500) + 1 JOIN lc ON lc.i = lg.club_i;
  INSERT INTO group_owners (club_id, group_id, person_id)
    SELECT lc.id, lg.id, lp.id FROM lg JOIN lc ON lc.i = lg.club_i JOIN lp ON lp.i = lg.i * 20;
  INSERT INTO employments (club_id, person_id, title, employment_type, starts_on)
    SELECT lc.id, lp.id, 'Coach', 'hourly', date '2025-01-01'
    FROM lp JOIN lc ON lc.i = (lp.i % 100) + 1 WHERE lp.i % 10 = 0;
  INSERT INTO platform_operators (person_id) SELECT id FROM lp WHERE i % 100 = 1;
  INSERT INTO support_access_grants (club_id, operator_person_id, granted_by_person_id, reason, expires_at)
    SELECT lc.id, lp.id, lp.id, 'Load', now() + interval '1 day'
    FROM lp JOIN lc ON lc.i = (lp.i % 100) + 1 WHERE lp.i % 10 = 1;
  INSERT INTO join_requests (club_id, person_id, requested_by_person_id)
    SELECT lc.id, lp.id, lp.id FROM lp JOIN lc ON lc.i = ((lp.i + 7) % 100) + 1 WHERE lp.i % 5 = 0;
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

/** Tables that stay tiny (a handful of platform operators): a scan is the right plan. */
const SMALL_TABLES = new Set(["Seq Scan platform_operators"]);

const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => n.startsWith("Seq Scan") && !SMALL_TABLES.has(n))).toEqual([]);

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

  it("relationship set (one statement, by person)", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(tx, authorizationQueries.relationshipSetQuery(ids.person)),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("roster page (app.visible_group_members)", async () => {
    const nodes = await c.t.db.withTenant(actor(ids.person, ids.club), (tx) =>
      plan(
        tx,
        membershipQueries.groupMembersPageQuery(ids.club, ids.group, { cursor: null, limit: 51 }),
      ),
    );
    noSeqScan(nodes);
    expect(nodes).toMatchSnapshot();
  });

  it("pending join requests of a club, oldest first (P1.1)", async () => {
    const nodes = await c.t.db.withTenant(actor(ids.person, ids.club), (tx) =>
      plan(
        tx,
        sql`SELECT * FROM join_requests WHERE club_id = ${ids.club} AND status = 'pending'
            ORDER BY created_at, id LIMIT 51`,
      ),
    );
    noSeqScan(nodes);
    expect(nodes).toContain("Index Scan join_requests join_requests_club_status_idx");
  });

  it("my join requests (by person, across clubs; P1.1)", async () => {
    const nodes = await c.t.db.withActor(actor(ids.person), (tx) =>
      plan(
        tx,
        sql`SELECT * FROM join_requests WHERE person_id = ${ids.person} OR requested_by_person_id = ${ids.person}`,
      ),
    );
    noSeqScan(nodes);
  });

  it("protected set of a club", async () => {
    const nodes = await c.t.db.withSystem("test", { clubId: ids.club }, (tx) =>
      plan(tx, authorizationQueries.protectedSetQuery(ids.club)),
    );
    noSeqScan(nodes);
    // No snapshot: the club_profiles probes switch between two equivalent indexes.
    expect(nodes).toEqual(
      expect.arrayContaining([
        "Index Scan club_profiles club_profiles_protected_idx",
        "Index Scan people people_protected_idx",
      ]),
    );
  });

  it("the queries return the right rows through row-level security", async () => {
    const mine = await c.s.memberships.myClubsAndGroups(actor(ids.person), ids.person);
    expect(mine.clubs).toHaveLength(1);
    expect(mine.groups).toHaveLength(1);
    expect(await c.s.guardianships.wardsOf(actor(ids.person), ids.person)).toHaveLength(1);
  });
});
