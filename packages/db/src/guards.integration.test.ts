// SPDX-License-Identifier: AGPL-3.0-only
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findGuardViolations } from "./guards.ts";
import { migrate, MigrationChecksumError } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

async function violations() {
  const client = new pg.Client({ connectionString: t.url("owner") });
  await client.connect();
  try {
    return await findGuardViolations(client);
  } finally {
    await client.end();
  }
}

describe("CI guards", () => {
  it("pass on the migrated database", async () => {
    expect(await violations()).toEqual([]);
  });

  it("report tables without RLS, history or updated_at trigger", async () => {
    await t.query(
      "owner",
      `CREATE TABLE public.bad_items (id uuid PRIMARY KEY DEFAULT uuidv7(), club_id uuid NOT NULL, updated_at timestamptz);
       CREATE TABLE public.half_done (id uuid PRIMARY KEY DEFAULT uuidv7(), club_id uuid NOT NULL);
       CREATE TABLE public.global_items (id uuid PRIMARY KEY DEFAULT uuidv7());
       SELECT history.enable_history('public.global_items');
       CREATE TABLE public.club_refs (id uuid PRIMARY KEY DEFAULT uuidv7(), club_id uuid);
       SELECT history.enable_history('public.club_refs');
       ALTER TABLE public.club_refs ENABLE ROW LEVEL SECURITY;
       ALTER TABLE public.half_done ENABLE ROW LEVEL SECURITY;
       SELECT history.enable_history('public.half_done');`,
    );
    const found = (await violations()).map((v) => `${v.rule}:${v.object}`).sort();
    expect(found).toEqual([
      "history:public.bad_items",
      "rls:public.bad_items",
      "rls:public.global_items", // no club_id, but still needs RLS
      "rls:public.half_done", // enabled but not forced
      // public.club_refs: a nullable club_id is a reference, not ownership; enabled is enough
      "updated_at:public.bad_items",
    ]);
    await t.query(
      "owner",
      "DROP TABLE public.bad_items, public.half_done, public.global_items, public.club_refs",
    );
  });

  it("report app-role privileges that would allow rewriting history", async () => {
    await t.query("admin", "GRANT UPDATE ON audit.events TO clubadmin_app");
    expect((await violations()).map((v) => v.message)).toContain("clubadmin_app has UPDATE");
    await t.query("admin", "REVOKE UPDATE ON audit.events FROM clubadmin_app");
  });
});

describe("migrations", () => {
  it("are idempotent", async () => {
    expect((await migrate({ ownerUrl: t.url("owner") })).applied).toEqual([]);
    const status = await t.db.migrationStatus();
    expect(status).toEqual({ pending: [], changed: [], unknown: [] });
  });

  it("refuse to run when an applied migration file has changed", async () => {
    await t.query(
      "owner",
      "UPDATE app_meta.schema_migrations SET checksum = 'tampered' WHERE name = '0000_foundation'",
    );
    await expect(migrate({ ownerUrl: t.url("owner") })).rejects.toBeInstanceOf(
      MigrationChecksumError,
    );
    expect((await t.db.migrationStatus()).changed).toEqual(["0000_foundation"]);
  });
});
