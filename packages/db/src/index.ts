// SPDX-License-Identifier: AGPL-3.0-only
// @clubadmin/db: the only way application code reaches PostgreSQL.

export { audit, type AuditEvent } from "./audit.ts";
export type { ActorContext, ActorKind, TenantContext } from "./context.ts";
export { createDatabase, type Database, type Tx } from "./database.ts";
export { getRecordHistory, type RecordChange, type RecordHistoryPage } from "./history.ts";
export * as tables from "./infra/tables.ts";
export type { MigrationStatus } from "./migrate.ts";
export { type DispatchResult, outbox, type OutboxEvent, type OutboxHandler } from "./outbox.ts";
export { sql } from "drizzle-orm";
