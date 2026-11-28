// SPDX-License-Identifier: AGPL-3.0-only
// Semantic audit events (CLAUDE.md rule 3): call audit.record in the same
// transaction as the change. Club, actor, request and IP hash come from the
// transaction's context.

import type { AuditAction } from "@clubadmin/shared";
import { sql } from "drizzle-orm";

import type { Tx } from "./database.ts";

export interface AuditEvent {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  /** Names of changed fields only, never their values. */
  changedFields?: readonly string[];
}

async function record(tx: Tx, event: AuditEvent): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit.events (
      club_id, actor_person_id, on_behalf_of_person_id, actor_kind,
      action, resource_type, resource_id, changed_fields, ip_hash, request_id
    ) VALUES (
      app.current_club_id(), app.current_person_id(), app.current_on_behalf_of(),
      coalesce(app.current_actor_kind(), 'db_role'),
      ${event.action}, ${event.resourceType}, ${event.resourceId ?? null},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(event.changedFields ?? [])}::jsonb)),
      app.setting('app.ip_hash'), app.current_request_id()
    )`);
}

/**
 * Several events in one statement (laying out a programme, P2.9: hundreds
 * of activities and shifts in one request, ADR 0040).
 */
async function recordMany(tx: Tx, events: readonly AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => ({
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    changedFields: e.changedFields ?? [],
  }));
  await tx.execute(sql`
    INSERT INTO audit.events (
      club_id, actor_person_id, on_behalf_of_person_id, actor_kind,
      action, resource_type, resource_id, changed_fields, ip_hash, request_id
    )
    SELECT app.current_club_id(), app.current_person_id(), app.current_on_behalf_of(),
      coalesce(app.current_actor_kind(), 'db_role'),
      e.action, e."resourceType", e."resourceId",
      ARRAY(SELECT jsonb_array_elements_text(e."changedFields")),
      app.setting('app.ip_hash'), app.current_request_id()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS e(action text, "resourceType" text, "resourceId" uuid, "changedFields" jsonb)`);
}

export const audit = { record, recordMany };
