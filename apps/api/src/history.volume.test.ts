// SPDX-License-Identifier: AGPL-3.0-only
// History and audit on volume (P1.9, ADR 0042): not in the CI workflow. The
// Nightly workflow (and anyone, by hand) seeds the load scenario and the
// history volume, then runs `pnpm --filter @clubadmin/api test:volume`
// against the local database:
//   pnpm db:reset --scenario load && pnpm db:seed --history-volume
// Storklubben then has two years of history (about 5 million rows) and
// audit events (about 500,000). Checked: the plans (no sequential scans of
// history partitions or the audit log; the club index newest first over the
// partitions; a filtered period prunes partitions) and the time budgets
// (docs/performance.md: panels < 300 ms p95, club-wide and audit < 500 ms).

import {
  auditEventsSql,
  clubHistorySql,
  createDatabase,
  type Database,
  readAuditEvents,
  readClubHistory,
  readRecordsHistory,
  recordsHistorySql,
  type SQL,
  sql,
  type TenantContext,
} from "@clubadmin/db";
import { loadEnvFiles } from "@clubadmin/server-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvFiles();

const DAY = 86_400_000;
const RUNS = 20;

let db: Database;
let context: TenantContext;
let managerId: string;
let clubId: string;
let memberRecords: { table: string; id: string }[];

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

async function plan(query: SQL): Promise<PlanNode[]> {
  const { rows } = await db.withTenant(context, (tx) =>
    tx.execute<{ "QUERY PLAN": { Plan: PlanNode }[] }>(sql`EXPLAIN (FORMAT JSON) ${query}`),
  );
  return nodes(rows[0]!["QUERY PLAN"][0]!.Plan);
}

const seqScans = (all: PlanNode[]) =>
  all.filter(
    (n) =>
      n["Node Type"] === "Seq Scan" && /^(record_changes|events)/.test(n["Relation Name"] ?? ""),
  );

async function p95(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.ceil(RUNS * 0.95) - 1]!;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (pnpm dev:services)");
  db = createDatabase({ url, max: 2, readOnly: true, applicationName: "clubadmin-volume" });
  const found = await db.withSystem("volume:setup", {}, (tx) =>
    tx.execute<{ club: string; manager: string }>(sql`
      SELECT c.id AS club, r.person_id AS manager FROM clubs c
      JOIN club_role_assignments r ON r.club_id = c.id AND r.role = 'club_manager'
      WHERE c.slug = 'load-large' LIMIT 1`),
  );
  const row = found.rows[0];
  if (!row)
    throw new Error(
      "No Storklubben: pnpm db:reset --scenario load && pnpm db:seed --history-volume",
    );
  clubId = row.club;
  managerId = row.manager;
  context = {
    actorKind: "person",
    personId: row.manager,
    clubId,
    requestId: "volume",
    viewerPrivileged: true,
  };
  const count = await db.withSystem("volume:setup", {}, (tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM history.record_changes WHERE request_id = 'volume'`,
    ),
  );
  if ((count.rows[0]?.n ?? 0) < 1_000_000) {
    throw new Error("No history volume: pnpm db:seed --history-volume");
  }
  // The panel of the member with five years of changes (member number 1).
  memberRecords = (
    await db.withTenant(context, (tx) =>
      tx.execute<{ t: string; id: string }>(sql`
        SELECT 'public.club_memberships' AS t, ms.id FROM club_memberships ms
        JOIN club_profiles cp ON cp.club_id = ms.club_id AND cp.person_id = ms.person_id
        WHERE ms.club_id = ${clubId} AND cp.member_number = 1
        UNION ALL
        SELECT 'public.club_profiles', cp.id FROM club_profiles cp
        WHERE cp.club_id = ${clubId} AND cp.member_number = 1`),
    )
  ).rows.map((r) => ({ table: r.t, id: r.id }));
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe("history and audit on volume", () => {
  it("reads the club-wide changes newest first on the club index, without scans", async () => {
    const all = await plan(clubHistorySql(clubId, {}, { before: null, limit: 51 }));
    expect(seqScans(all)).toEqual([]);
    expect(all.some((n) => n["Node Type"] === "Merge Append")).toBe(true);
    expect(all.some((n) => (n["Index Name"] ?? "").includes("club_id_changed_at_id"))).toBe(true);
  });

  it("prunes partitions for a filtered period and stays on the club index", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * DAY);
    const all = await plan(
      clubHistorySql(
        clubId,
        { tables: ["public.group_memberships"], actorPersonId: managerId, from, to },
        { before: null, limit: 51 },
      ),
    );
    expect(seqScans(all)).toEqual([]);
    const partitions = new Set(
      all.flatMap((n) =>
        n["Relation Name"]?.startsWith("record_changes") ? [n["Relation Name"]] : [],
      ),
    );
    expect(partitions.size).toBeLessThanOrEqual(5);
  });

  it("reads a panel by record and the audit log by its indexes", async () => {
    expect(
      seqScans(await plan(recordsHistorySql(memberRecords, { before: null, limit: 51 }))),
    ).toEqual([]);
    for (const filter of [{}, { actions: ["members.exported"] }, { actorPersonId: managerId }]) {
      expect(
        seqScans(await plan(auditEventsSql(clubId, filter, { before: null, limit: 51 }))),
      ).toEqual([]);
    }
  });

  it("meets the time budgets", async () => {
    const page = { before: null, limit: 51 };
    const to = new Date();
    const from = new Date(to.getTime() - 90 * DAY);
    const panel = await p95(() =>
      db.withTenant(context, (tx) => readRecordsHistory(tx, memberRecords, page)),
    );
    const club = await p95(() =>
      db.withTenant(context, (tx) => readClubHistory(tx, clubId, {}, page)),
    );
    const filtered = await p95(() =>
      db.withTenant(context, (tx) =>
        readClubHistory(tx, clubId, { tables: ["public.consents"], from, to }, page),
      ),
    );
    const audit = await p95(() =>
      db.withTenant(context, (tx) => readAuditEvents(tx, clubId, {}, page)),
    );
    const auditActor = await p95(() =>
      db.withTenant(context, (tx) =>
        readAuditEvents(tx, clubId, { actorPersonId: managerId }, page),
      ),
    );
    // eslint-disable-next-line no-console -- the measured times in the Nightly log
    console.log({ panel, club, filtered, audit, auditActor });
    expect(panel).toBeLessThan(300);
    expect(club).toBeLessThan(500);
    expect(filtered).toBeLessThan(500);
    expect(audit).toBeLessThan(500);
    expect(auditActor).toBeLessThan(500);
  });
});
