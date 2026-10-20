// SPDX-License-Identifier: AGPL-3.0-only
// The raw connection pool. Internal: application code reaches the database
// only through withTenant/withActor/withSystem (dependency-cruiser enforces it).
import pg from "pg";

export interface PoolOptions {
  url: string;
  max?: number;
  applicationName?: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? "clubadmin",
  });
  // Errors on idle clients must not crash the process; the next query reports them.
  pool.on("error", () => undefined);
  return pool;
}
