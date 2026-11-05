// SPDX-License-Identifier: AGPL-3.0-only
// The history view policy against the database catalogue (P1.9, ADR 0042):
// every history-enabled table is either shown (with a policy) or listed as
// never shown with a reason, and every column the policy names exists. A
// new column of a listed table needs no entry: it is name_only until
// classified.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HISTORY_POLICY, isNeverShown } from "./history-columns.ts";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe("history view policy", () => {
  it("covers every history-enabled table or lists it as never shown", async () => {
    const { rows } = await t.query<{ name: string }>(
      "admin",
      `SELECT DISTINCT c.relnamespace::regnamespace || '.' || c.relname AS name
       FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       WHERE g.tgfoid = 'history.capture'::regproc ORDER BY 1`,
    );
    const covered = new Set(HISTORY_POLICY.map((p) => p.table));
    expect(rows.map((r) => r.name).filter((n) => !covered.has(n) && !isNeverShown(n))).toEqual([]);
    // A table in the policy is not also never shown, and has history.
    const enabled = new Set(rows.map((r) => r.name));
    expect(HISTORY_POLICY.filter((p) => isNeverShown(p.table) || !enabled.has(p.table))).toEqual(
      [],
    );
  });

  it("names only columns that exist, and about and link columns that hold IDs", async () => {
    const { rows } = await t.query<{ name: string; column: string; type: string }>(
      "admin",
      `SELECT c.table_schema || '.' || c.table_name AS name, c.column_name AS column,
         c.data_type AS type
       FROM information_schema.columns c
       WHERE c.table_schema IN ('public', 'billing')`,
    );
    const columns = new Map<string, Map<string, string>>();
    for (const r of rows) {
      const table = columns.get(r.name) ?? new Map<string, string>();
      table.set(r.column, r.type);
      columns.set(r.name, table);
    }
    const missing: string[] = [];
    const notIds: string[] = [];
    for (const policy of HISTORY_POLICY) {
      const table = columns.get(policy.table)!;
      for (const column of Object.keys(policy.columns)) {
        if (!table.has(column)) missing.push(`${policy.table}.${column}`);
      }
      for (const column of [...policy.about.map((a) => a.column), policy.link?.column ?? "id"]) {
        if (table.get(column) !== "uuid") notIds.push(`${policy.table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
    expect(notIds).toEqual([]);
  });
});
