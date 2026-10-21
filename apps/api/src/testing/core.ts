// SPDX-License-Identifier: AGPL-3.0-only
// Integration-test harness for the domain modules: a fresh database per test
// file and the services wired to it.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll } from "vitest";

import { type CoreServices, createCoreServices } from "./services.ts";

export interface CoreTest {
  t: TestDatabase;
  s: CoreServices;
}

/** Registers beforeAll/afterAll hooks; read the fields inside tests. */
export function useCoreDatabase(): CoreTest {
  const holder = {} as CoreTest;
  beforeAll(async () => {
    holder.t = await createTestDatabase();
    holder.s = createCoreServices(holder.t.db);
  });
  afterAll(async () => {
    await holder.t?.drop();
  });
  return holder;
}

/** Rows of the record history for a record, oldest first. */
export async function historyOf(
  t: TestDatabase,
  table: string,
  recordId: string,
): Promise<
  {
    operation: string;
    changed_columns: string[];
    actor_person_id: string | null;
    actor_kind: string;
  }[]
> {
  const { rows } = await t.query<{
    operation: string;
    changed_columns: string[];
    actor_person_id: string | null;
    actor_kind: string;
  }>(
    "admin",
    `SELECT operation, changed_columns, actor_person_id, actor_kind FROM history.record_changes
     WHERE table_name = $1 AND record_id = $2 ORDER BY changed_at, id`,
    [table, recordId],
  );
  return rows;
}

/** Audit actions recorded for a resource, oldest first. */
export async function auditActionsOf(t: TestDatabase, resourceId: string): Promise<string[]> {
  const { rows } = await t.query<{ action: string }>(
    "admin",
    "SELECT action FROM audit.events WHERE resource_id = $1 ORDER BY created_at, id",
    [resourceId],
  );
  return rows.map((r) => r.action);
}
