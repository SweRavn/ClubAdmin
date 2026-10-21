// SPDX-License-Identifier: AGPL-3.0-only
// Outbox handler that invalidates the authorization caches (ADR 0006,
// ADR 0022): relationship changes bump the version of every affected
// person's relationship set, protection and membership changes the version of
// the protected sets. The API compares versions on every read, so a change is
// visible on the first request after the worker handled the event.
//
// group.parent.changed needs no invalidation: group hierarchies are read with
// each group resource, not cached in relationship sets.

import {
  type DomainEventType,
  PROTECTED_GLOBAL_VERSION_KEY,
  protectedVersionKey,
  relationshipVersionKey,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";

import type { Tx } from "./database.ts";
import type { OutboxEvent, OutboxHandler } from "./outbox.ts";

/** Increments version counters (Valkey INCR in the worker). Must be safe to repeat. */
export interface CacheVersions {
  bump(keys: readonly string[]): Promise<void>;
}

const TYPES = [
  "membership.changed",
  "role.changed",
  "group.owner.changed",
  "guardianship.changed",
  "person.protection.changed",
  "person.merged",
] as const satisfies readonly DomainEventType[];

/** Active guardians of the people (their relationship sets include their wards' memberships). */
async function guardiansOf(tx: Tx, personIds: readonly string[]): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT guardian_person_id AS id FROM public.guardianships
    WHERE ward_person_id = ANY (ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(personIds)}::jsonb))::uuid[])
      AND status = 'active' AND valid_to IS NULL`);
  return rows.map((r) => r.id);
}

async function isGloballyProtected(tx: Tx, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ protected: boolean }>(
    sql`SELECT protected_identity AS protected FROM public.people WHERE id = ${personId}`,
  );
  return rows[0]?.protected === true;
}

/** The version keys an event invalidates. */
export async function invalidatedKeys(event: OutboxEvent, tx: Tx): Promise<string[]> {
  const people = new Set<string>();
  const keys = new Set<string>();
  switch (event.type) {
    case "membership.changed": {
      const { clubId, personId } = event.payload as OutboxEvent<"membership.changed">["payload"];
      people.add(personId);
      for (const guardian of await guardiansOf(tx, [personId])) people.add(guardian);
      // A newly joined member may be protected through the global flag.
      keys.add(protectedVersionKey(clubId));
      break;
    }
    case "role.changed":
    case "group.owner.changed": {
      const { personId } = event.payload as OutboxEvent<"role.changed">["payload"];
      people.add(personId);
      break;
    }
    case "guardianship.changed": {
      const { guardianPersonId, wardPersonId } =
        event.payload as OutboxEvent<"guardianship.changed">["payload"];
      people.add(guardianPersonId).add(wardPersonId);
      // Protected sets include protected guardians of members.
      if (await isGloballyProtected(tx, guardianPersonId)) keys.add(PROTECTED_GLOBAL_VERSION_KEY);
      break;
    }
    case "person.protection.changed": {
      const { clubId } = event.payload as OutboxEvent<"person.protection.changed">["payload"];
      keys.add(clubId ? protectedVersionKey(clubId) : PROTECTED_GLOBAL_VERSION_KEY);
      break;
    }
    case "person.merged": {
      const { keptPersonId, mergedPersonId } =
        event.payload as OutboxEvent<"person.merged">["payload"];
      people.add(keptPersonId).add(mergedPersonId);
      for (const guardian of await guardiansOf(tx, [keptPersonId, mergedPersonId]))
        people.add(guardian);
      // Memberships moved between people, possibly in several clubs.
      keys.add(PROTECTED_GLOBAL_VERSION_KEY);
      break;
    }
    default:
      break;
  }
  for (const personId of people) keys.add(relationshipVersionKey(personId));
  return [...keys];
}

export function authorizationCacheHandler(versions: CacheVersions): OutboxHandler {
  return {
    name: "authorization-cache",
    types: TYPES,
    async handle(event, tx) {
      const keys = await invalidatedKeys(event, tx);
      if (keys.length > 0) await versions.bump(keys);
    },
  };
}
