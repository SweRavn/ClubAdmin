// SPDX-License-Identifier: AGPL-3.0-only
// Structural checks that make the CLAUDE.md rules impossible to forget
// (run by the integration tests on a freshly migrated database):
// - every table with club_id has row-level security enabled and forced;
// - every table has the record-history trigger unless excluded (history-exclusions.ts);
// - every table with updated_at has the trigger that maintains it;
// - clubadmin_app cannot bypass RLS, run DDL, own objects or rewrite history/audit.

import type pg from "pg";

import { isHistoryExcluded } from "./history-exclusions.ts";
import { ROLES } from "./roles.ts";

export interface GuardViolation {
  rule: "rls" | "history" | "updated_at" | "app-role";
  object: string;
  message: string;
}

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

// Ordinary and partitioned tables, not partitions (they inherit from their parent).
const TABLES_SQL = `
  SELECT n.nspname || '.' || c.relname AS name, c.oid, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_temp%'`;

export async function findGuardViolations(client: pg.ClientBase): Promise<GuardViolation[]> {
  const violations: GuardViolation[] = [];

  const { rows: tables } = await client.query<{
    name: string;
    oid: number;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    has_club_id: boolean;
    has_updated_at: boolean;
    has_history: boolean;
    has_updated_at_trigger: boolean;
  }>(`
    SELECT t.*,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'club_id' AND NOT a.attisdropped) AS has_club_id,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'updated_at' AND NOT a.attisdropped) AS has_updated_at,
      EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = t.oid AND g.tgfoid = 'history.capture'::regproc) AS has_history,
      EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = t.oid AND g.tgfoid = 'app.set_updated_at'::regproc) AS has_updated_at_trigger
    FROM (${TABLES_SQL}) t
    ORDER BY t.name`);

  for (const t of tables) {
    const infra = isHistoryExcluded(t.name);
    if (t.has_club_id && !infra && !(t.relrowsecurity && t.relforcerowsecurity)) {
      violations.push({
        rule: "rls",
        object: t.name,
        message:
          "has club_id but row-level security is not enabled and forced: SELECT app.enable_tenant_rls(...)",
      });
    }
    if (!t.has_history && !infra) {
      violations.push({
        rule: "history",
        object: t.name,
        message:
          "has no record-history trigger: SELECT history.enable_history(...), or add it to history-exclusions.ts with a reason",
      });
    }
    if (t.has_updated_at && !t.has_updated_at_trigger && !infra) {
      violations.push({
        rule: "updated_at",
        object: t.name,
        message: "has updated_at but no trigger maintaining it: SELECT app.enable_updated_at(...)",
      });
    }
  }

  const app = ROLES.app;
  const { rows: roleRows } = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1",
    [app],
  );
  if (roleRows[0]?.rolbypassrls || roleRows[0]?.rolsuper) {
    violations.push({ rule: "app-role", object: app, message: "can bypass row-level security" });
  }

  const { rows: ddl } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ${SYSTEM_SCHEMAS} AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast%'
       AND has_schema_privilege($1, oid, 'CREATE')`,
    [app],
  );
  for (const r of ddl) {
    violations.push({
      rule: "app-role",
      object: r.nspname,
      message: `${app} can create objects in this schema`,
    });
  }

  const { rows: owned } = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
    [app],
  );
  for (const r of owned)
    violations.push({ rule: "app-role", object: r.name, message: `owned by ${app}` });

  for (const table of ["history.record_changes", "audit.events"]) {
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
      const { rows } = await client.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, $3) AS allowed",
        [app, table, privilege],
      );
      if (rows[0]?.allowed) {
        violations.push({ rule: "app-role", object: table, message: `${app} has ${privilege}` });
      }
    }
  }
  const { rows: historyInsert } = await client.query<{ allowed: boolean }>(
    "SELECT has_table_privilege($1, 'history.record_changes', 'INSERT') AS allowed",
    [app],
  );
  if (historyInsert[0]?.allowed) {
    violations.push({
      rule: "app-role",
      object: "history.record_changes",
      message: `${app} can insert directly (only the history trigger may)`,
    });
  }

  return violations;
}
