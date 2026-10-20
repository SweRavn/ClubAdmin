// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL connection pool. Only used for health checks until the database
// foundation (P0.4) adds Drizzle, roles and tenant-scoped transactions.

import pg from "pg";

export const DATABASE_POOL = Symbol("DATABASE_POOL");

export type DatabasePool = pg.Pool | undefined;

export function createDatabasePool(url: string | undefined): DatabasePool {
  if (!url) return undefined;
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: "clubadmin-api",
  });
  // Errors on idle clients must not crash the process; the next query reports them.
  pool.on("error", () => undefined);
  return pool;
}
