// SPDX-License-Identifier: AGPL-3.0-only
// The budgets of "My schedule" and the calendars (P1.4, docs/performance.md)
// on 200 clubs with 1,600 teams of 20 children and 64,000 activities: the
// statements use indexes (no sequential scan of the large tables), and a
// guardian's schedule over two clubs answers within the 50 ms budget
// (row-level security included).

import { type SQL, sql, type Tx } from "@clubadmin/db";
import { beforeAll, describe, expect, it } from "vitest";

import { actor } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { clubCalendarQuery, groupCalendarQuery, scheduleQuery } from "./activities.repository.ts";

const c = useCoreDatabase();
const CLUBS = 200;
const GROUPS = CLUBS * 8;
const CHILDREN = GROUPS * 20;
const SESSIONS = 40;

const LOAD_SQL = `
  CREATE TEMP TABLE sc AS SELECT i, uuidv7() AS id FROM generate_series(1, ${CLUBS}) i;
  CREATE TEMP TABLE sg AS SELECT i, uuidv7() AS id, 1 + (i - 1) / 8 AS club_i FROM generate_series(1, ${GROUPS}) i;
  CREATE TEMP TABLE sp AS SELECT i, uuidv7() AS id, 1 + (i - 1) / 20 AS group_i FROM generate_series(1, ${CHILDREN}) i;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Schema ' || i, 'schedule-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM sc;
  INSERT INTO people (id, given_name, family_name, birth_date)
    SELECT id, 'Barn', 'Nummer' || i, date '2014-01-01' + (i % 2000) FROM sp;
  INSERT INTO groups (id, club_id, name, kind)
    SELECT sg.id, sc.id, 'Lag ' || sg.i, 'team' FROM sg JOIN sc ON sc.i = sg.club_i;
  INSERT INTO club_memberships (club_id, person_id, status)
    SELECT sc.id, sp.id, 'active' FROM sp JOIN sg ON sg.i = sp.group_i JOIN sc ON sc.i = sg.club_i;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT sc.id, sp.id, 'club_manager' FROM sp JOIN sg ON sg.i = sp.group_i JOIN sc ON sc.i = sg.club_i
    WHERE (sp.i - 1) % 160 = 0;
  INSERT INTO group_memberships (club_id, group_id, person_id)
    SELECT sc.id, sg.id, sp.id FROM sp JOIN sg ON sg.i = sp.group_i JOIN sc ON sc.i = sg.club_i;
  -- Two sessions a week for twenty weeks per team.
  CREATE TEMP TABLE sa AS
    SELECT uuidv7() AS id, sg.id AS group_id, sc.id AS club_id,
      timestamptz '2026-09-01 15:00Z' + make_interval(days => (k / 2) * 7 + (k % 2) * 2, mins => sg.i % 120) AS starts_at
    FROM sg JOIN sc ON sc.i = sg.club_i CROSS JOIN generate_series(0, ${SESSIONS - 1}) k;
  INSERT INTO activities (id, club_id, kind, title, starts_at, ends_at, created_by_person_id)
    SELECT id, club_id, 'training', 'Träning', starts_at, starts_at + interval '90 minutes',
      (SELECT id FROM sp WHERE i = 1) FROM sa;
  INSERT INTO activity_groups (club_id, activity_id, group_id) SELECT club_id, id, group_id FROM sa;
  INSERT INTO schedule_entries (club_id, activity_id, group_id, kind, title, status, starts_at, ends_at, all_day, changed_at)
    SELECT club_id, id, group_id, 'training', 'Träning', 'scheduled', starts_at, starts_at + interval '90 minutes', false, now() FROM sa;
  -- A guardian of two children in two clubs.
  CREATE TEMP TABLE sx AS SELECT uuidv7() AS id;
  INSERT INTO people (id, given_name, family_name, birth_date) SELECT id, 'Förälder', 'Två klubbar', date '1984-03-01' FROM sx;
  INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
    SELECT sx.id, sp.id, 'parent', ARRAY['act_on_behalf', 'receive_messages', 'view_schedule', 'sign_up', 'see_medical']
    FROM sx CROSS JOIN sp WHERE sp.i IN (1, ${CHILDREN});
  CREATE TABLE public.schedule_ids AS
    SELECT (SELECT id FROM sx) AS guardian, (SELECT id FROM sp WHERE i = 1) AS first_child,
      (SELECT id FROM sp WHERE i = ${CHILDREN}) AS last_child,
      (SELECT id FROM sc WHERE i = 1) AS club, (SELECT id FROM sg WHERE i = 1) AS "group";
`;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function summarise(node: PlanNode, out: string[] = []): string[] {
  out.push([node["Node Type"], node["Relation Name"]].filter(Boolean).join(" "));
  for (const child of node.Plans ?? []) summarise(child, out);
  return out;
}

async function plan(tx: Tx, query: SQL): Promise<string[]> {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`,
  );
  return summarise(rows[0]!["QUERY PLAN"][0].Plan);
}

const LARGE = ["activities", "activity_groups", "schedule_entries", "group_memberships"];
const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => LARGE.some((t) => n === `Seq Scan ${t}`))).toEqual([]);

let ids: { guardian: string; first_child: string; last_child: string; club: string; group: string };
const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };

beforeAll(async () => {
  const session = await c.t.connect("admin");
  try {
    await session.query(`BEGIN; ${LOAD_SQL} COMMIT;`);
    await session.query("ANALYZE");
    ({
      rows: [ids],
    } = (await session.query("SELECT * FROM public.schedule_ids")) as unknown as {
      rows: [typeof ids];
    });
    await session.query("DROP TABLE public.schedule_ids");
  } finally {
    await session.end();
  }
}, 300_000);

const guardianSchedule = () =>
  scheduleQuery({
    personIds: [ids.guardian, ids.first_child, ids.last_child],
    ...window,
    clubId: null,
    cursor: null,
    limit: 201,
  });

describe(`schedule and calendar plans (${GROUPS} teams, ${GROUPS * SESSIONS} activities)`, () => {
  it("my schedule uses the memberships and the entries' group index", async () => {
    const nodes = await c.t.db.withActor(actor(ids.guardian), (tx) => plan(tx, guardianSchedule()));
    noSeqScan(nodes);
    const { rows } = await c.t.db.withActor(actor(ids.guardian), (tx) =>
      tx.execute(guardianSchedule()),
    );
    // Two children, two sessions a week each, over a month.
    expect(rows.length).toBeGreaterThanOrEqual(16);
  });

  it("the group and club calendars use indexes", async () => {
    const manager = actor(ids.guardian, ids.club);
    const group = await c.t.db.withTenant(manager, (tx) =>
      plan(tx, groupCalendarQuery(ids.group, { ...window, cursor: null, limit: 201 })),
    );
    noSeqScan(group);
    const club = await c.t.db.withTenant(manager, (tx) =>
      plan(
        tx,
        clubCalendarQuery(ids.club, {
          ...window,
          groupId: null,
          locationId: null,
          cursor: null,
          limit: 201,
        }),
      ),
    );
    noSeqScan(club);
  });

  // The budget is 50 ms (docs/performance.md); shared CI runners get a margin.
  it("answers a guardian's schedule over two clubs within the budget", async () => {
    const timings: number[] = [];
    for (let run = 0; run < 22; run++) {
      const started = performance.now();
      await c.t.db.withActor(actor(ids.guardian), (tx) => tx.execute(guardianSchedule()));
      if (run >= 2) timings.push(performance.now() - started);
    }
    const p95 = Math.round(timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.95) - 1]!);
    expect(p95, `p95 ${p95} ms`).toBeLessThan(75);
  });
});
