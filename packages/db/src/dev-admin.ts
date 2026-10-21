// SPDX-License-Identifier: AGPL-3.0-only
// Superuser helpers for development tooling (the demo seed, db:reset):
// recreating the database and running statements as superuser. Never used by
// the application.

import pg from "pg";

export type AdminQuery = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: R[] }>;

/** Runs `fn` with a superuser connection to the database of `adminUrl`. */
export async function withAdminConnection<T>(
  adminUrl: string,
  fn: (query: AdminQuery) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: adminUrl,
    application_name: "clubadmin-dev-admin",
  });
  await client.connect();
  try {
    return await fn((text, values) => client.query(text, values));
  } finally {
    await client.end();
  }
}

/** Drops (closing its connections) and creates the database of `adminUrl`. */
export async function recreateDatabase(adminUrl: string): Promise<void> {
  const url = new URL(adminUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}
