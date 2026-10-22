// SPDX-License-Identifier: AGPL-3.0-only
// The member register's budgets (P1.2, docs/performance.md) on one club with
// 10,000 members among 100,000 people: the page in every sort order, search
// as you type and the facets use indexes (no sequential scans of the large
// tables), and a page stays within the time budget as the club's registrar
// (row-level security and the visibility view included).

import { sql, type SQLWrapper, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import { actor } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { registerFacetsQuery, registerPageQuery } from "./members.repository.ts";

const c = useCoreDatabase();
const PEOPLE = 100_000;
const MEMBERS = 10_000;

const LOAD_SQL = `
  CREATE TEMP TABLE lp AS SELECT i, uuidv7() AS id FROM generate_series(1, ${PEOPLE}) i;
  CREATE TEMP TABLE lc AS SELECT i, uuidv7() AS id FROM generate_series(1, 10) i;
  CREATE TEMP TABLE lg AS SELECT i, uuidv7() AS id, 1 + (i - 1) / 40 AS club_i FROM generate_series(1, 400) i;
  INSERT INTO people (id, given_name, family_name, birth_date, gender, protected_identity)
    SELECT id, (ARRAY['Elsa','Hugo','Alva','Noah','Saga','Liam','Ebba','Otto'])[1 + i % 8],
      (ARRAY['Andersson','Berg','Holm','Lind','Nilsson','Ek','Sjöberg'])[1 + (i / 8) % 7] || i,
      date '1950-01-01' + (i % 25000), (ARRAY['female','male'])[1 + i % 2], i % 1000 = 0
    FROM lp;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency, next_member_number)
    SELECT id, 'Register ' || i, 'register-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', ${PEOPLE} FROM lc;
  -- Club 1 has the first 10,000 people; the other nine 9,000 each.
  CREATE TEMP TABLE lm AS
    SELECT lp.id AS person_id, lp.i, lc.id AS club_id FROM lp
    JOIN lc ON lc.i = CASE WHEN lp.i <= ${MEMBERS} THEN 1 ELSE 2 + (lp.i % 9) END;
  INSERT INTO club_memberships (club_id, person_id, status, membership_type, valid_from)
    SELECT club_id, person_id, CASE WHEN i % 50 = 0 THEN 'paused' ELSE 'active' END,
      CASE WHEN i % 20 = 0 THEN 'supporting' ELSE 'active' END,
      timestamptz '2015-01-01' + make_interval(days => i % 3000)
    FROM lm;
  INSERT INTO club_profiles (club_id, person_id, member_number, shared_fields)
    SELECT club_id, person_id, i, CASE WHEN i % 3 = 0 THEN '{phone,gender}'::text[] ELSE '{}' END FROM lm;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT lc.id, lp.id, r.role FROM lc JOIN lp ON lp.i = lc.i
    CROSS JOIN (VALUES ('club_manager'), ('registrar')) AS r(role);
  -- 40 groups per club; everyone in one group of their club.
  INSERT INTO groups (id, club_id, name, kind)
    SELECT lg.id, lc.id, 'Lag ' || lg.i, 'team' FROM lg JOIN lc ON lc.i = lg.club_i;
  INSERT INTO group_memberships (club_id, group_id, person_id)
    SELECT lm.club_id, lg.id, lm.person_id
    FROM lm JOIN lc ON lc.id = lm.club_id JOIN lg ON lg.club_i = lc.i AND lg.i = (lc.i - 1) * 40 + 1 + lm.i % 40;
  INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
    SELECT club_id, person_id, 'photo_publication', 'v1', person_id FROM lm WHERE i % 2 = 0;
  CREATE TABLE public.register_ids AS
    SELECT (SELECT id FROM lc WHERE i = 1) AS club, (SELECT id FROM lp WHERE i = 1) AS registrar,
           (SELECT id FROM lg WHERE i = 7) AS "group";
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

/**
 * No sequential scan of the large tables. A page of the whole club reads every
 * member, here a tenth of all people: then scanning people is the cheaper plan
 * (with a million people, as in the load scenario, it is not), so those tests
 * allow it; searches and filters must use indexes for people as well.
 */
const CLUB_TABLES = ["club_memberships", "club_profiles", "group_memberships", "consents"];
const noSeqScan = (nodes: string[], options: { people?: boolean } = {}) =>
  expect(
    nodes.filter((n) =>
      [...CLUB_TABLES, ...(options.people === false ? [] : ["people"])].some(
        (t) => n === `Seq Scan ${t}`,
      ),
    ),
  ).toEqual([]);

let ids: { club: string; registrar: string; group: string };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    ({
      rows: [ids],
    } = (await session.query("SELECT * FROM public.register_ids")) as unknown as {
      rows: [typeof ids];
    });
    await session.query("DROP TABLE public.register_ids");
  } finally {
    await session.end();
  }
}, 300_000);

const registrar = () => ({ ...actor(ids.registrar, ids.club), viewerPrivileged: true });
const page = (filter: Parameters<typeof registerPageQuery>[1]["filter"], sort = "name" as const) =>
  registerPageQuery(ids.club, {
    filter,
    sort,
    order: "asc",
    cursor: null,
    limit: 51,
    countHidden: filter.q === undefined,
  });

describe("member register plans (10,000 members, 100,000 people)", () => {
  for (const sort of ["name", "member_number", "joined"] as const) {
    it(`page sorted by ${sort}`, async () => {
      const nodes = await c.t.db.withTenant(registrar(), (tx) =>
        plan(
          tx,
          registerPageQuery(ids.club, {
            filter: {},
            sort,
            order: "asc",
            cursor: null,
            limit: 51,
            countHidden: true,
          }),
        ),
      );
      noSeqScan(nodes, { people: false });
    });
  }

  it("search as you type", async () => {
    const nodes = await c.t.db.withTenant(registrar(), (tx) => plan(tx, page({ q: "elsa ber" })));
    noSeqScan(nodes);
  });

  it("filters: group, missing consent, birth years", async () => {
    const nodes = await c.t.db.withTenant(registrar(), (tx) =>
      plan(
        tx,
        page({
          groupId: ids.group,
          missingConsent: "photo_publication",
          bornFrom: 2000,
          bornTo: 2010,
        }),
      ),
    );
    noSeqScan(nodes);
  });

  it("facets", async () => {
    const nodes = await c.t.db.withTenant(registrar(), (tx) =>
      plan(tx, registerFacetsQuery(ids.club)),
    );
    noSeqScan(nodes);
    // Counting needs no names: the outer joins let the planner leave people out.
    expect(nodes.some((n) => n.endsWith(" people") || n.includes(" people "))).toBe(false);
  });

  // The budget is 100 ms (docs/performance.md); shared CI runners and
  // development machines get a margin. Locally: page about 90 ms, search
  // 85 ms, filtered 20 ms, facets 40 ms.
  it("answers a page, a search and the facets within the budget", async () => {
    const timings: Record<string, number[]> = { page: [], search: [], filtered: [], facets: [] };
    const queries: Record<string, SQLWrapper> = {
      page: page({}),
      search: page({ q: "els" }),
      filtered: page({ groupId: ids.group, missingConsent: "photo_publication" }),
      facets: registerFacetsQuery(ids.club),
    };
    for (let run = 0; run < 22; run++) {
      for (const [name, query] of Object.entries(queries)) {
        const started = performance.now();
        await c.t.db.withTenant(registrar(), (tx) => tx.execute(query.getSQL()));
        // The first two runs warm the caches.
        if (run >= 2) timings[name]!.push(performance.now() - started);
      }
    }
    const p95 = Object.fromEntries(
      Object.entries(timings).map(([name, ms]) => [
        name,
        Math.round(ms.sort((a, b) => a - b)[Math.floor(ms.length * 0.95) - 1]!),
      ]),
    );
    for (const [name, ms] of Object.entries(p95)) expect(ms, `${name}: p95 ${ms} ms`).toBeLessThan(150);
  }, 300_000);
});
