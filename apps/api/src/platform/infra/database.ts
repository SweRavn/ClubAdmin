// SPDX-License-Identifier: AGPL-3.0-only
// The database, reached only through withTenant/withActor/withSystem
// (@clubadmin/db). Undefined when DATABASE_URL is not set (unit tests).
import { createDatabase, type Database } from "@clubadmin/db";

import { ProblemError } from "../http/problem-error.ts";

export const DATABASE = Symbol("DATABASE");

export type OptionalDatabase = Database | undefined;

export function createApiDatabase(url: string | undefined, max = 10): OptionalDatabase {
  return url ? createDatabase({ url, max, applicationName: "clubadmin-api" }) : undefined;
}

/**
 * Services get a Database even when DATABASE_URL is not set (unit tests of the
 * HTTP layer); every call then fails as "unavailable".
 */
export function requireDatabase(db: OptionalDatabase): Database {
  if (db) return db;
  const unavailable = (): never => {
    throw new ProblemError("unavailable", { detail: "database not configured" });
  };
  return {
    withTenant: unavailable,
    withActor: unavailable,
    withSystem: unavailable,
    ping: unavailable,
    migrationStatus: unavailable,
    close: async () => {},
  };
}
