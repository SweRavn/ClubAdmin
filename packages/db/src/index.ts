// SPDX-License-Identifier: AGPL-3.0-only
// @clubadmin/db: the only way application code reaches PostgreSQL.

export { audit, type AuditEvent } from "./audit.ts";
export {
  authorizationCacheHandler,
  type CacheVersions,
  invalidatedKeys,
} from "./authorization-cache.ts";
export { inClub } from "./club-context.ts";
export type { ActorContext, ActorKind, TenantContext } from "./context.ts";
export { createDatabase, type Database, type Tx } from "./database.ts";
export {
  databaseError,
  type DatabaseErrorInfo,
  isCheckViolation,
  isForeignKeyViolation,
  isRlsViolation,
  isUniqueViolation,
} from "./errors.ts";
export { getRecordHistory, type RecordChange, type RecordHistoryPage } from "./history.ts";
export * as tables from "./infra/tables.ts";
export { dataKeyStore, type StoredDataKey } from "./keys.ts";
export type { MigrationStatus } from "./migrate.ts";
export { type DispatchResult, outbox, type OutboxEvent, type OutboxHandler } from "./outbox.ts";
export * as schema from "./schema/index.ts";
// Query operators for repositories (only packages/db depends on drizzle-orm).
export {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
