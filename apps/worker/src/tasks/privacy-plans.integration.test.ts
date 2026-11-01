// SPDX-License-Identifier: AGPL-3.0-only
// The privacy retention statements on volume (P1.8a, docs/performance.md):
// 100 clubs of 1,000 members, 15 % of them former members who left over the
// last five years, 1 % of all people marked orphaned, and 600,000 audit
// events over three years. The former-member scan of a club, the orphans
// due for erasure and a batch of audit retention use their indexes (no
// sequential scan of the large tables), as clubadmin_retention.

import { createDatabase, type Database, type SQL, sql, type Tx } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditRetentionQuery, formerMembersQuery, orphansQuery } from "./privacy.ts";

let t: TestDatabase;
let retention: Database;
const CLUBS = 100;
const PER_CLUB = 1_000;
const AUDIT_EVENTS = 600_000;

// Loaded without triggers (no record history, member numbers given): only
// the plans matter here.
const LOAD_SQL = `
  SET LOCAL session_replication_role = replica;
  CREATE TEMP TABLE pc AS SELECT i, uuidv7() AS id FROM generate_series(1, ${CLUBS}) i;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Plan ' || i, 'plan-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM pc;
  CREATE TEMP TABLE pp AS
    SELECT pc.id AS club, k, uuidv7() AS id FROM pc CROSS JOIN generate_series(1, ${PER_CLUB}) k;
  INSERT INTO people (id, given_name, family_name, birth_date, orphaned_since)
    SELECT id, 'Medlem', 'Nummer' || k, date '1990-01-01' + (k % 5000),
      CASE WHEN k % 100 = 0 THEN now() - make_interval(days => k % 1500) END
    FROM pp;
  INSERT INTO club_profiles (club_id, person_id, member_number) SELECT club, id, k FROM pp;
  -- Every seventh member left, spread over five years, the rest are active.
  INSERT INTO club_memberships (club_id, person_id, status, valid_from, valid_to)
    SELECT club, id,
      CASE WHEN k % 7 = 0 THEN 'left' ELSE 'active' END,
      now() - interval '6 years',
      CASE WHEN k % 7 = 0 THEN now() - make_interval(days => (k * 13) % 1825) END
    FROM pp;
  INSERT INTO audit.events (id, created_at, actor_kind, action, resource_type, resource_id)
    SELECT uuidv7(-make_interval(mins => i * 2)), now() - make_interval(mins => i * 2),
      'system_job', 'person.updated', 'person', NULL
    FROM generate_series(1, ${AUDIT_EVENTS}) i;
  CREATE TABLE public.privacy_plan_ids AS SELECT (SELECT id FROM pc WHERE i = 1) AS club;
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

async function plan(tx: Tx, query: SQL): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

const LARGE = ["club_memberships", "club_profiles", "people", "events"];
const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => LARGE.some((table) => n === `Seq Scan ${table}`))).toEqual([]);
const uses = (nodes: string[], index: string) =>
  expect(
    nodes.some((n) => n.includes(index)),
    nodes.join(" / "),
  ).toBe(true);

let club: string;
const asRetention = <T>(fn: (tx: Tx) => Promise<T>, clubId?: string) =>
  retention.withSystem("test:plans", clubId ? { clubId } : {}, fn);

beforeAll(async () => {
  t = await createTestDatabase();
  retention = createDatabase({ url: t.url("retention"), max: 1 });
  const session = await t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    const { rows } = (await session.query(
      "SELECT club FROM public.privacy_plan_ids",
    )) as unknown as {
      rows: [{ club: string }];
    };
    club = rows[0].club;
    await session.query("DROP TABLE public.privacy_plan_ids");
  } finally {
    await session.end();
  }
}, 600_000);
afterAll(async () => {
  await retention?.close();
  await t?.drop();
});

describe(`privacy retention plans (${CLUBS * PER_CLUB} members, ${AUDIT_EVENTS} audit events)`, () => {
  it("finds a club's former members past the period through the left index", async () => {
    const nodes = await asRetention((tx) => plan(tx, formerMembersQuery(club)), club);
    noSeqScan(nodes);
    uses(nodes, "club_memberships_left_idx");
  });

  it("finds the orphans due for erasure through the orphan index", async () => {
    const nodes = await asRetention((tx) => plan(tx, orphansQuery(36)));
    noSeqScan(nodes);
    uses(nodes, "people_orphaned_idx");
  });

  // Run daily, audit retention removes about a day's events: the run finds
  // only the oldest past the period.
  it("deletes audit events by the creation index", async () => {
    const nodes = await asRetention((tx) => plan(tx, auditRetentionQuery(24)));
    noSeqScan(nodes);
    uses(nodes, "events_created_idx");
  });
});
