// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm db:bootstrap`: creates the database roles and grants. Idempotent; run
// as a superuser (DATABASE_ADMIN_URL). Also used by self-hosters.

import { readFileSync } from "node:fs";

import pg from "pg";

import { ROLE_PASSWORD_ENV, type RoleKey, ROLES } from "./roles.ts";
import { databaseName } from "./urls.ts";

const ROLES_SQL = new URL("../sql/roles.sql", import.meta.url);

export interface BootstrapOptions {
  /** Superuser connection to the target database. */
  adminUrl: string;
  /** Role passwords; roles without one stay NOLOGIN. */
  passwords: Partial<Record<RoleKey, string>>;
}

export function passwordsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<RoleKey, string>> {
  const result: Partial<Record<RoleKey, string>> = {};
  for (const key of Object.keys(ROLES) as RoleKey[]) {
    const value = env[ROLE_PASSWORD_ENV[key]];
    if (value) result[key] = value;
  }
  return result;
}

/** Cluster-level roles and passwords. */
export async function bootstrapRoles(
  client: pg.Client,
  passwords: BootstrapOptions["passwords"],
): Promise<void> {
  await client.query(readFileSync(ROLES_SQL, "utf8"));
  // The application runs short queries: JIT compilation costs more than it
  // saves (about 90 ms on a page of a 10,000-member register, P1.2).
  for (const role of [ROLES.app, ROLES.operator]) {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} SET jit = off`);
  }
  for (const [key, password] of Object.entries(passwords) as [RoleKey, string][]) {
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(ROLES[key])} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  }
}

/**
 * Database-level grants. Not copied by CREATE DATABASE ... TEMPLATE, so test
 * databases run this again after cloning.
 */
export async function bootstrapDatabase(client: pg.Client, database: string): Promise<void> {
  const db = client.escapeIdentifier(database);
  const { owner, app, operator, retention } = ROLES;
  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${owner}, ${app}, ${operator}, ${retention}`,
  );
  await client.query(`GRANT CREATE ON DATABASE ${db} TO ${owner}`);
  await client.query(`ALTER SCHEMA public OWNER TO ${owner}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
}

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const client = new pg.Client({
    connectionString: options.adminUrl,
    application_name: "clubadmin-bootstrap",
  });
  // A connection reset (Docker Desktop's port proxy right after a restart) then
  // fails the pending query instead of crashing the process as an unhandled
  // "error" event.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await bootstrapRoles(client, options.passwords);
    await bootstrapDatabase(client, databaseName(options.adminUrl));
  } finally {
    await client.end();
  }
}
