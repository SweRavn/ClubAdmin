// SPDX-License-Identifier: AGPL-3.0-only
// A template database, migrated once and rebuilt only when the migrations
// change. Each test file clones it (CREATE DATABASE ... TEMPLATE), which takes
// a fraction of a second.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

import { bootstrapDatabase, bootstrapRoles } from "../bootstrap.ts";
import { migrate, readMigrationFiles } from "../migrate.ts";
import { withDatabase } from "../urls.ts";
import { testEnv } from "./env.ts";

export const TEMPLATE_DATABASE = "clubadmin_test_template";

function templateChecksum(): string {
  const hash = createHash("sha256");
  // Everything that shapes the migrated database: roles, grants, runner, migrations.
  for (const source of ["../../sql/roles.sql", "../bootstrap.ts", "../migrate.ts"]) {
    hash.update(readFileSync(new URL(source, import.meta.url)));
  }
  for (const file of readMigrationFiles()) hash.update(`${file.name}:${file.checksum}\n`);
  return hash.digest("hex");
}

async function withAdmin<T>(database: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: withDatabase(testEnv().adminUrl, database),
    application_name: "clubadmin-test",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Builds the template if missing or outdated. Safe to call from parallel processes. */
export async function ensureTemplate(): Promise<void> {
  const env = testEnv();
  const checksum = templateChecksum();
  await withAdmin("postgres", async (admin) => {
    await admin.query("SELECT pg_advisory_lock(hashtext('clubadmin:test-template'))");
    try {
      const { rows } = await admin.query<{ description: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS description FROM pg_database WHERE datname = $1`,
        [TEMPLATE_DATABASE],
      );
      if (rows[0]?.description === checksum) return;

      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
      await bootstrapRoles(admin, env.passwords);
      await withAdmin(TEMPLATE_DATABASE, (client) => bootstrapDatabase(client, TEMPLATE_DATABASE));
      await migrate({ ownerUrl: env.urlFor("owner", TEMPLATE_DATABASE) });
      await admin.query(
        `COMMENT ON DATABASE ${TEMPLATE_DATABASE} IS ${admin.escapeLiteral(checksum)}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtext('clubadmin:test-template'))");
    }
  });
}

/** Clones the template into a new database and applies the database-level grants. */
export async function cloneTemplate(name: string): Promise<void> {
  await withAdmin("postgres", async (admin) => {
    // Concurrent clones of one template can conflict; serialise them (each takes milliseconds).
    await admin.query("SELECT pg_advisory_lock(hashtext('clubadmin:test-clone'))");
    try {
      await admin.query(
        `CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${TEMPLATE_DATABASE}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtext('clubadmin:test-clone'))");
    }
  });
  await withAdmin(name, (client) => bootstrapDatabase(client, name));
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdmin("postgres", (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`),
  );
}

export { withAdmin };
