// SPDX-License-Identifier: AGPL-3.0-only
// Tenant-scoped transactions (CLAUDE.md rule 1, ADR 0004). Every query runs in
// a transaction that first records who is acting and in which club, using
// transaction-local settings (set_config(..., true)), so row-level security,
// record history and audit events see them, and PgBouncer transaction pooling
// keeps working.

import { DrizzleQueryError } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";

import { type ActorContext, type Settings, settingsFor, type TenantContext } from "./context.ts";
import { createPool, type PoolOptions } from "./internal/pool.ts";
import { compareMigrations, type MigrationStatus, readMigrationFiles } from "./migrate.ts";

/**
 * The transaction handle passed to withTenant/withActor/withSystem callbacks:
 * a Drizzle database bound to the transaction's connection. Do not nest
 * transactions; use SAVEPOINT through tx.execute if you need one.
 */
export type Tx = Omit<NodePgDatabase, "transaction" | "$client">;

export interface Database {
  /** Runs `fn` in a transaction scoped to one club, as the given actor. */
  withTenant<T>(context: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs `fn` as the given actor without a club (global tables such as people and accounts). */
  withActor<T>(context: ActorContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs `fn` as a background job (actor kind system_job), optionally in a club. */
  withSystem<T>(
    jobName: string,
    options: { clubId?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  /** Checks connectivity (health checks). */
  ping(): Promise<void>;
  /** Pending or changed migrations compared with the files shipped with this version. */
  migrationStatus(): Promise<MigrationStatus>;
  close(): Promise<void>;
}

/** BEGIN and the context settings in one round trip (values are escaped literals). */
function beginSql(client: pg.PoolClient, settings: Settings): string {
  const assignments = (Object.entries(settings) as [string, string][])
    .map(
      ([name, value]) =>
        `set_config(${client.escapeLiteral(name)}, ${client.escapeLiteral(value)}, true)`,
    )
    .join(", ");
  return `BEGIN; SELECT ${assignments}`;
}

/**
 * Drizzle wraps database errors in a message that includes the query
 * parameters, which may be personal data and would end up in logs. Rethrow
 * the underlying PostgreSQL error instead (its message has no values; its
 * `detail` may, and is redacted by the logger).
 */
export function unwrapQueryError(error: unknown): unknown {
  if (error instanceof DrizzleQueryError && error.cause instanceof Error) return error.cause;
  return error;
}

export function createDatabase(options: PoolOptions): Database {
  const pool = createPool(options);
  const migrationFiles = readMigrationFiles();

  const run = async <T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(beginSql(client, settings));
      const tx = drizzle({ client, casing: "snake_case" });
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
      });
      throw unwrapQueryError(error);
    } finally {
      // A connection whose rollback failed is discarded rather than reused.
      client.release(broken);
    }
  };

  return {
    withTenant: async (context, fn) => {
      if (!context.clubId) throw new Error("withTenant requires clubId");
      return run(
        settingsFor(context, context.clubId, { viewerPrivileged: context.viewerPrivileged }),
        fn,
      );
    },
    withActor: async (context, fn) => run(settingsFor(context), fn),
    withSystem: async (jobName, { clubId }, fn) =>
      run(settingsFor({ actorKind: "system_job", requestId: `job:${jobName}` }, clubId), fn),
    ping: async () => {
      await pool.query("SELECT 1");
    },
    migrationStatus: async () => {
      const { rows } = await pool.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM app_meta.schema_migrations",
      );
      return compareMigrations(migrationFiles, rows);
    },
    close: () => pool.end(),
  };
}
