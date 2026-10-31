// SPDX-License-Identifier: AGPL-3.0-only
// The worker's notification statements on volume (P1.7, docs/performance.md):
// 20,000 recipients with 25 notices each and their push and email
// deliveries (1.5 million rows), and 200 clubs with 40,000 activities. Due
// deliveries, the hourly push budget, the daily email's recipients, the
// answer-reminder scan and retention use their indexes (no sequential scan
// of the large tables), as the app role in system context.

import { type SQL, sql, type Tx } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { digestRecipientsQuery, dueQuery, pushBudgetQuery } from "./deliver.ts";
import { reminderScanQuery, retentionQueries } from "./tasks.ts";

let t: TestDatabase;
const RECIPIENTS = 20_000;
const PER_RECIPIENT = 25;
const CLUBS = 200;
const PER_CLUB = 200;

const LOAD_SQL = `
  CREATE TEMP TABLE np AS SELECT i, uuidv7() AS id FROM generate_series(1, ${RECIPIENTS}) i;
  INSERT INTO people (id, given_name, family_name, birth_date)
    SELECT id, 'Förälder', 'Nummer' || i, date '1980-01-01' + (i % 5000) FROM np;
  INSERT INTO accounts (person_id, email, email_verified_at)
    SELECT id, 'plan' || i || '@example.test', now() FROM np;
  CREATE TEMP TABLE nn AS
    SELECT uuidv7(-make_interval(hours => k * 80, secs => np.i)) AS id, np.id AS recipient, k,
      now() - make_interval(hours => k * 80, secs => np.i) AS created_at
    FROM np CROSS JOIN generate_series(0, ${PER_RECIPIENT - 1}) k;
  INSERT INTO notifications (id, recipient_person_id, category, type, subject_type, params, dedupe_key,
                             read_at, created_at)
    SELECT id, recipient, 'schedule', 'activity.cancelled', 'activity', '{"title": "Träning"}'::jsonb,
      'plan:' || id, CASE WHEN k > 1 THEN created_at END, created_at
    FROM nn;
  -- Push sent at once; email in the daily email: sent, except today's (held until 17:00).
  INSERT INTO notification_deliveries (notification_id, channel, status, digest, send_after, sent_at, created_at)
    SELECT id, 'push', 'sent', false, created_at, created_at + interval '1 minute', created_at FROM nn;
  INSERT INTO notification_deliveries (notification_id, channel, status, digest, send_after, sent_at, created_at)
    SELECT id, 'email', CASE WHEN k = 0 THEN 'held' ELSE 'sent' END, true,
      CASE WHEN k = 0 THEN now() + interval '5 hours' ELSE created_at + interval '6 hours' END,
      CASE WHEN k = 0 THEN NULL ELSE created_at + interval '6 hours' END, created_at
    FROM nn;
  -- A few due now.
  UPDATE notification_deliveries SET send_after = now() - interval '1 minute'
    WHERE status = 'held' AND notification_id IN (SELECT id FROM nn WHERE k = 0 AND recipient IN
      (SELECT id FROM np WHERE i % 500 = 0));
  -- Clubs with requested and plain activities over the coming weeks.
  CREATE TEMP TABLE nc AS SELECT i, uuidv7() AS id FROM generate_series(1, ${CLUBS}) i;
  INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
    SELECT id, 'Plan ' || i, 'plan-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK' FROM nc;
  INSERT INTO club_role_assignments (club_id, person_id, role)
    SELECT id, (SELECT id FROM np WHERE i = 1), 'club_manager' FROM nc;
  INSERT INTO activities (club_id, kind, title, starts_at, ends_at, created_by_person_id, response_mode)
    SELECT nc.id, 'training', 'Träning', now() + make_interval(hours => k * 3),
      now() + make_interval(hours => k * 3 + 1), (SELECT id FROM np WHERE i = 1),
      CASE WHEN k % 10 = 0 THEN 'requested' ELSE 'none' END
    FROM nc CROSS JOIN generate_series(1, ${PER_CLUB}) k;
  CREATE TABLE public.notification_plan_ids AS
    SELECT (SELECT id FROM nc WHERE i = 1) AS club,
      ARRAY(SELECT id FROM np WHERE i % 200 = 0) AS people;
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

const LARGE = ["notifications", "notification_deliveries", "activities"];
const noSeqScan = (nodes: string[]) =>
  expect(nodes.filter((n) => LARGE.some((table) => n === `Seq Scan ${table}`))).toEqual([]);
const uses = (nodes: string[], index: string) =>
  expect(
    nodes.some((n) => n.includes(index)),
    nodes.join(" / "),
  ).toBe(true);

let ids: { club: string; people: string[] };
const system = <T>(fn: (tx: Tx) => Promise<T>, clubId?: string) =>
  t.db.withSystem("test:plans", clubId ? { clubId } : {}, fn);

beforeAll(async () => {
  t = await createTestDatabase();
  const session = await t.connect("admin");
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
}, 600_000);
afterAll(async () => {
  await t?.drop();
});

describe(`notification worker plans (${RECIPIENTS * PER_RECIPIENT} notices, ${CLUBS * PER_CLUB} activities)`, () => {
  it("due push and email come from the due index; one person's daily email from their inbox", async () => {
    const now = new Date();
    await system(async (tx) => {
      for (const query of [dueQuery("push", false, now), dueQuery("email", false, now)]) {
        const nodes = await plan(tx, query);
        noSeqScan(nodes);
        uses(nodes, "notification_deliveries_due_idx");
      }
      const recipients = await plan(tx, digestRecipientsQuery(now));
      noSeqScan(recipients);
      uses(recipients, "notification_deliveries_due_idx");
      // The daily email of one recipient: their notices, then each one's deliveries.
      const one = await plan(
        tx,
        dueQuery("email", true, now, sql`AND n.recipient_person_id = ${ids.people[0]!}`),
      );
      noSeqScan(one);
      uses(one, "notifications_inbox_idx");
    });
  });

  it("the hourly push budget reads only the last hour's pushes", async () => {
    await system(async (tx) => {
      const nodes = await plan(tx, pushBudgetQuery(ids.people, new Date()));
      noSeqScan(nodes);
      uses(nodes, "notification_deliveries_push_sent_idx");
    });
  });

  it("the answer-reminder scan uses the reminder index in the club", async () => {
    const nodes = await system((tx) => plan(tx, reminderScanQuery(new Date())), ids.club);
    noSeqScan(nodes);
    uses(nodes, "activities_reminder_idx");
  });

  // Run daily, retention removes about a day's rows: the run 49 days on finds
  // only the oldest deliveries past 30 days (and no notices past 90).
  it("retention deletes by the creation indexes", async () => {
    const queries = retentionQueries(new Date(Date.now() - 49 * 86_400_000));
    await system(async (tx) => {
      const deliveries = await plan(tx, queries.deliveries);
      noSeqScan(deliveries);
      uses(deliveries, "notification_deliveries_created_idx");
      const notices = await plan(tx, queries.notices);
      noSeqScan(notices);
      uses(notices, "notifications_created_idx");
    });
  });
});
