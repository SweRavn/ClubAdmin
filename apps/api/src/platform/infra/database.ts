// SPDX-License-Identifier: AGPL-3.0-only
// The database, reached only through withTenant/withActor/withSystem
// (@clubadmin/db). Undefined when DATABASE_URL is not set (unit tests).
import { createDatabase, type Database } from "@clubadmin/db";

export const DATABASE = Symbol("DATABASE");

export type OptionalDatabase = Database | undefined;

export function createApiDatabase(url: string | undefined): OptionalDatabase {
  return url ? createDatabase({ url, max: 10, applicationName: "clubadmin-api" }) : undefined;
}
