// SPDX-License-Identifier: AGPL-3.0-only
// Test helpers for integration tests against a real PostgreSQL
// (`pnpm dev:services`, then `pnpm test:integration`).

import { uuidv7 } from "@clubadmin/shared";
import pg from "pg";
import { expect } from "vitest";

import type { TenantContext } from "../context.ts";
import { createDatabase, type Database, type Tx } from "../database.ts";
import type { ROLES } from "../roles.ts";
import { testEnv } from "./env.ts";
import { cloneTemplate, dropDatabase, withAdmin } from "./template.ts";

export interface TestDatabase {
  name: string;
  /** clubadmin_app, as the API and worker use it. */
  db: Database;
  /** Connection URL for a role, e.g. for the worker or for privilege tests. */
  url(role: keyof typeof ROLES): string;
  /** Runs SQL as a role in its own connection (e.g. owner for fixture tables, admin for "no context" changes). */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    role: keyof typeof ROLES | "admin",
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
  drop(): Promise<void>;
}

/** A fresh, migrated database for one test file. Call drop() in afterAll. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const env = testEnv();
  const name = `clubadmin_test_${uuidv7().replace(/-/g, "").slice(-16)}`;
  await cloneTemplate(name);
  const db = createDatabase({
    url: env.urlFor("app", name),
    applicationName: "clubadmin-test",
    max: 5,
  });
  return {
    name,
    db,
    url: (role) => env.urlFor(role, name),
    async query(role, text, values) {
      if (role === "admin") return withAdmin(name, (client) => client.query(text, values));
      const client = new pg.Client({ connectionString: env.urlFor(role, name) });
      await client.connect();
      try {
        return await client.query(text, values);
      } finally {
        await client.end();
      }
    },
    async drop() {
      await db.close();
      await dropDatabase(name);
    },
  };
}

/**
 * Club IDs for tests. Until the clubs table exists (P0.5) these are just
 * fresh UUIDs; club-owned rows reference them through club_id.
 */
export function createTestClubs(count: number): string[] {
  return Array.from({ length: count }, () => uuidv7());
}

/** Context of a person (new random ID unless given) acting in a club. */
export function asPerson(
  personId: string = uuidv7(),
  clubId: string,
  extra: Partial<TenantContext> = {},
): TenantContext {
  return { actorKind: "person", personId, clubId, requestId: `test-${uuidv7()}`, ...extra };
}

function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object") {
    const r = result as {
      rowCount?: unknown;
      rows?: unknown;
      statusCode?: unknown;
      status?: unknown;
    };
    if (r.statusCode === 404 || r.status === 404) return true;
    if (typeof r.rowCount === "number") return r.rowCount === 0;
    if (Array.isArray(r.rows)) return r.rows.length === 0;
  }
  return false;
}

/**
 * Runs `fn` as a person of `otherClubId` and asserts it sees or changes nothing
 * (empty array, null/undefined, rowCount 0, or a 404 response).
 */
export async function expectTenantIsolation(
  db: Database,
  otherClubId: string,
  fn: (tx: Tx) => Promise<unknown>,
): Promise<void> {
  const result = await db.withTenant(asPerson(undefined, otherClubId), fn);
  expect(
    isEmptyResult(result),
    `expected no rows from another club, got ${JSON.stringify(result)}`,
  ).toBe(true);
}

export { ensureTemplate, TEMPLATE_DATABASE } from "./template.ts";
