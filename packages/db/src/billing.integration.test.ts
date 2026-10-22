// SPDX-License-Identifier: AGPL-3.0-only
// Billing schema and club access state (migrations/0006): organisation data
// only, read by club managers, treasurers and operators, changed by operators
// and jobs; only operators change a club's access state.

import { uuidv7 } from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorContext } from "./context.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let t: TestDatabase;
const club = uuidv7();
const otherClub = uuidv7();
const manager = uuidv7();
const treasurer = uuidv7();
const member = uuidv7();
const operator = uuidv7();
const plan = uuidv7();

async function createClub(id: string, managerId: string): Promise<void> {
  const session = await t.connect("admin");
  try {
    await session.query("BEGIN");
    await session.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Billing IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [id, `billing-${id.slice(-8)}`],
    );
    await session.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [id, managerId],
    );
    await session.query("COMMIT");
  } finally {
    await session.end();
  }
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const id of [manager, treasurer, member, operator]) {
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'B', 'P')",
      [id],
    );
  }
  await createClub(club, manager);
  await createClub(otherClub, manager);
  await t.query(
    "admin",
    "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'treasurer')",
    [club, treasurer],
  );
  await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator]);
  await t.query(
    "admin",
    "INSERT INTO billing.plans (id, key, name, currency, price_minor) VALUES ($1, 'standard', 'Standard', 'SEK', 49900)",
    [plan],
  );
  for (const id of [club, otherClub]) {
    await t.query(
      "admin",
      "INSERT INTO billing.subscriptions (club_id, plan_id, status) VALUES ($1, $2, 'active')",
      [id, plan],
    );
  }
});
afterAll(async () => {
  await t?.drop();
});

const person = (personId: string): ActorContext => ({ actorKind: "person", personId });
const asOperator: ActorContext = { actorKind: "operator", personId: operator };

const subscriptionsSeen = (context: ActorContext, clubId?: string) =>
  (clubId
    ? t.db.withTenant({ ...context, clubId }, (tx) =>
        tx.execute<{ club_id: string }>(sql`SELECT club_id FROM billing.subscriptions`),
      )
    : t.db.withActor(context, (tx) =>
        tx.execute<{ club_id: string }>(sql`SELECT club_id FROM billing.subscriptions`),
      )
  ).then((r) => r.rows.map((row) => row.club_id).sort());

describe("billing schema", () => {
  it("references no person (organisation data only)", async () => {
    const { rows } = await t.query<{ ref: string }>(
      "admin",
      `SELECT c.conrelid::regclass::text || '.' || a.attname AS ref
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'public.people'::regclass
         AND c.conrelid::regclass::text LIKE 'billing.%'`,
    );
    expect(rows.map((r) => r.ref)).toEqual([]);
    // Nor columns that look like person IDs without a foreign key.
    const { rows: columns } = await t.query<{ name: string }>(
      "admin",
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
       WHERE table_schema = 'billing' AND column_name LIKE '%person%'`,
    );
    expect(columns).toEqual([]);
  });

  it("shows a club's subscription to its managers and treasurers only", async () => {
    expect(await subscriptionsSeen(person(manager), club)).toEqual([club]);
    expect(await subscriptionsSeen(person(treasurer), club)).toEqual([club]);
    expect(await subscriptionsSeen(person(member), club)).toEqual([]);
    // Treasurer of one club only.
    expect(await subscriptionsSeen(person(treasurer), otherClub)).toEqual([]);
  });

  it("shows operators every club's billing data, and jobs too", async () => {
    expect(await subscriptionsSeen(asOperator)).toEqual([club, otherClub].sort());
    // The same person acting as a person sees nothing.
    expect(await subscriptionsSeen(person(operator))).toEqual([]);
    const job = await t.db.withSystem("billing:test", { clubId: club }, (tx) =>
      tx.execute<{ club_id: string }>(sql`SELECT club_id FROM billing.subscriptions`),
    );
    expect(job.rows.map((r) => r.club_id)).toEqual([club]);
  });

  it("lets only operators and jobs change billing data", async () => {
    await expect(
      t.db.withTenant({ ...person(manager), clubId: club }, (tx) =>
        tx.execute(
          sql`UPDATE billing.subscriptions SET status = 'cancelled', cancelled_at = now()`,
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      t.db.withTenant({ ...person(manager), clubId: club }, (tx) =>
        tx.execute(
          sql`INSERT INTO billing.plans (key, name, currency) VALUES ('cheap', 'Cheap', 'SEK')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await t.db.withActor(asOperator, (tx) =>
      tx.execute(sql`UPDATE billing.subscriptions SET status = 'past_due' WHERE club_id = ${club}`),
    );
    expect(updated.rowCount).toBe(1);
  });
});

describe("clubs.access_state", () => {
  const setState = (context: ActorContext, state: string) =>
    t.db.withTenant({ ...context, clubId: club }, (tx) =>
      tx.execute(sql`UPDATE clubs SET access_state = ${state} WHERE id = ${club}`),
    );

  it("cannot be changed by the club's manager", async () => {
    await expect(setState(person(manager), "active")).resolves.toBeDefined();
    await expect(setState(person(manager), "read_only")).rejects.toThrow(/only operators/);
  });

  it("is changed by operators and jobs, and recorded in the history", async () => {
    await setState(asOperator, "read_only");
    await t.db.withSystem("billing:test", { clubId: club }, (tx) =>
      tx.execute(sql`UPDATE clubs SET access_state = 'active' WHERE id = ${club}`),
    );
    const { rows } = await t.query<{ actor_kind: string; new_values: Record<string, unknown> }>(
      "admin",
      `SELECT actor_kind, new_values FROM history.record_changes
       WHERE table_name = 'public.clubs' AND record_id = $1 AND operation = 'UPDATE'
         AND 'access_state' = ANY (changed_columns)
       ORDER BY changed_at`,
      [club],
    );
    expect(rows).toEqual([
      { actor_kind: "operator", new_values: { access_state: "read_only" } },
      { actor_kind: "system_job", new_values: { access_state: "active" } },
    ]);
  });
});
