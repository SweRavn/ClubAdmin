// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm db:migrate`: applies Graphile Worker's schema, then every SQL file in
// migrations/ in order, each in its own transaction, as clubadmin_owner.
// Applied migrations are recorded with a checksum; changing an applied file is
// an error (migrations are forward-only, CLAUDE.md rule 13).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { Logger, makeWorkerUtils } from "graphile-worker";
import pg from "pg";

import { ROLES } from "./roles.ts";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export interface MigrationFile {
  name: string;
  checksum: string;
  sql: string;
}

export function readMigrationFiles(dir: URL = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(new URL(file, dir), "utf8");
      return {
        name: file.replace(/\.sql$/, ""),
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    });
}

export class MigrationChecksumError extends Error {
  constructor(names: string[]) {
    super(
      `Already applied migrations have changed: ${names.join(", ")}. ` +
        "Migrations are forward-only: never edit a migration that has been applied; add a new one.",
    );
    this.name = "MigrationChecksumError";
  }
}

const LOCK_KEY = "clubadmin:migrate";

const META_SQL = `
  CREATE SCHEMA IF NOT EXISTS app_meta;
  CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  );
  GRANT USAGE ON SCHEMA app_meta TO ${ROLES.app}, ${ROLES.operator};
  GRANT SELECT ON app_meta.schema_migrations TO ${ROLES.app}, ${ROLES.operator};
`;

// Graphile Worker installs its own schema (owned by clubadmin_owner); the
// worker uses it as clubadmin_app. Its tables have row-level security enabled
// without policies (owner-only), so the app role gets an explicit policy.
// Re-run after every Graphile Worker upgrade, which may add tables.
const GRAPHILE_GRANTS_SQL = `
  GRANT USAGE ON SCHEMA graphile_worker TO ${ROLES.app};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${ROLES.app};
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${ROLES.app};
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${ROLES.app};
  DO $grants$
  DECLARE t record;
  BEGIN
    FOR t IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'clubadmin_app_access')
    LOOP
      EXECUTE format('CREATE POLICY clubadmin_app_access ON graphile_worker.%I TO ${ROLES.app} USING (true) WITH CHECK (true)', t.relname);
    END LOOP;
  END
  $grants$;
`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export interface MigrateOptions {
  /** Connection as clubadmin_owner. */
  ownerUrl: string;
  log?: (message: string) => void;
  dir?: URL;
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = readMigrationFiles(options.dir);

  // 1. Graphile Worker schema (the outbox trigger calls graphile_worker.add_job).
  const workerUtils = await makeWorkerUtils({
    connectionString: options.ownerUrl,
    logger: new Logger(() => () => undefined),
  });
  try {
    await workerUtils.migrate();
  } finally {
    await workerUtils.release();
  }

  const client = new pg.Client({
    connectionString: options.ownerUrl,
    application_name: "clubadmin-migrate",
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await client.query(META_SQL);
    await client.query(GRAPHILE_GRANTS_SQL);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM app_meta.schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const changed = files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum);
    if (changed.length > 0) throw new MigrationChecksumError(changed.map((f) => f.name));

    const result: MigrateResult = { applied: [], alreadyApplied: applied.size };
    for (const file of files.filter((f) => !applied.has(f.name))) {
      const started = performance.now();
      await client.query("BEGIN");
      try {
        // Data changes made by migrations are recorded as such in the history.
        await client.query(
          "SELECT set_config('app.actor_kind', 'migration', true), set_config('app.request_id', $1, true)",
          [`migration:${file.name}`],
        );
        await client.query(file.sql);
        await client.query(
          "INSERT INTO app_meta.schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)",
          [file.name, file.checksum, Math.round(performance.now() - started)],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        );
      }
      result.applied.push(file.name);
      log(`applied ${file.name} (${Math.round(performance.now() - started)} ms)`);
    }
    return result;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

export interface MigrationStatus {
  pending: string[];
  changed: string[];
  unknown: string[];
}

/** Compares applied migrations with the files (used by /health/ready). */
export function compareMigrations(
  files: readonly MigrationFile[],
  applied: readonly { name: string; checksum: string }[],
): MigrationStatus {
  const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));
  const fileNames = new Set(files.map((f) => f.name));
  return {
    pending: files.filter((f) => !appliedMap.has(f.name)).map((f) => f.name),
    changed: files
      .filter((f) => appliedMap.has(f.name) && appliedMap.get(f.name) !== f.checksum)
      .map((f) => f.name),
    unknown: applied.filter((r) => !fileNames.has(r.name)).map((r) => r.name),
  };
}
