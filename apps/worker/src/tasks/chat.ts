// SPDX-License-Identifier: AGPL-3.0-only
// Chat jobs (P2.1, ADR 0047):
// - chat:sync_person (outbox: a person's groups, roles or club relationship
//   changed): the default channels of their groups follow the groups, the
//   guardian rule runs in their chats, and someone without a relationship
//   to the club leaves its chats (app.chat_sync_person).
// - chat:sync_family (outbox: a guardianship changed): the same for the
//   ward, in every club the ward or the guardian has chats in.
// - chat:maintenance (daily): the coming months' message partitions, the
//   default channels of groups that have none yet, and the guardian rule
//   again in chats with children (a birthday can change who is a child).
// Changes are published on the real-time bus (IDs only) so open apps refresh.

import { type Database, type OutboxHandler, sql } from "@clubadmin/db";
import {
  DOMAIN_EVENTS,
  realtimeChatChannel,
  realtimePersonChannel,
  type RealtimeServerEvent,
  z,
} from "@clubadmin/shared";
import type { Task } from "graphile-worker";
import type { Redis } from "ioredis";

const BATCH = 500;

/** Publishes the changed chats to their members (and those who just left). */
async function publishChanged(
  db: Database,
  valkey: Redis | undefined,
  clubId: string,
  chatIds: readonly string[],
): Promise<void> {
  if (!valkey || chatIds.length === 0) return;
  const { rows } = await db.withSystem("chat:publish", { clubId }, (tx) =>
    tx.execute<{ person_id: string }>(sql`
      SELECT DISTINCT person_id FROM public.chat_members
      WHERE chat_id = ANY(${`{${chatIds.join(",")}}`}::uuid[])
        AND (status <> 'left' OR left_at > now() - interval '10 minutes')`),
  );
  const send = (channel: string, event: RealtimeServerEvent) =>
    valkey.publish(channel, JSON.stringify(event)).catch(() => 0);
  await Promise.all([
    ...chatIds.map((chatId) =>
      send(realtimeChatChannel(chatId), { type: "chat.updated", clubId, chatId }),
    ),
    ...rows.map((r) => send(realtimePersonChannel(r.person_id), { type: "chats.changed" })),
  ]);
}

/** Runs app.chat_sync_person in the club; returns the chats whose members changed. */
export async function syncPerson(
  db: Database,
  clubId: string,
  personId: string,
): Promise<string[]> {
  const { rows } = await db.withSystem("chat:sync_person", { clubId }, (tx) =>
    tx.execute<{ chat_id: string }>(
      sql`SELECT DISTINCT chat_id FROM app.chat_sync_person(${personId}::uuid)`,
    ),
  );
  return rows.map((r) => r.chat_id);
}

const PersonPayload = z.object({ clubId: z.uuid(), personId: z.uuid() });

export function syncPersonTask(db: Database, valkey?: Redis): Task {
  return async (payload, helpers) => {
    const { clubId, personId } = PersonPayload.parse(payload);
    const changed = await syncPerson(db, clubId, personId);
    await publishChanged(db, valkey, clubId, changed);
    helpers.logger.debug("chat memberships synced", { clubId, changed: changed.length });
  };
}

const FamilyPayload = z.object({ guardianPersonId: z.uuid(), wardPersonId: z.uuid() });

/**
 * The clubs either of them belongs to, or belonged to lately (a membership
 * that just ended still has chats to leave): system read, IDs only.
 */
async function clubsOfFamily(db: Database, ids: readonly string[]): Promise<string[]> {
  const { rows } = await db.withSystem("chat:sync_family", {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`
      SELECT DISTINCT club_id FROM public.club_memberships
      WHERE person_id = ANY(${`{${ids.join(",")}}`}::uuid[])
        AND (valid_to IS NULL OR valid_to > now() - interval '30 days')`),
  );
  return rows.map((r) => r.club_id);
}

export function syncFamilyTask(db: Database, valkey?: Redis): Task {
  return async (payload, helpers) => {
    const { guardianPersonId, wardPersonId } = FamilyPayload.parse(payload);
    for (const clubId of await clubsOfFamily(db, [guardianPersonId, wardPersonId])) {
      const changed = [
        ...new Set([
          ...(await syncPerson(db, clubId, wardPersonId)),
          ...(await syncPerson(db, clubId, guardianPersonId)),
        ]),
      ];
      await publishChanged(db, valkey, clubId, changed);
      helpers.logger.debug("chat memberships synced for a family", {
        clubId,
        changed: changed.length,
      });
    }
  };
}

export interface ChatMaintenanceResult {
  partitionsCreated: number;
  partitionsSkipped: number;
  defaultChannels: number;
  rechecked: number;
}

export async function runChatMaintenance(
  db: Database,
  valkey?: Redis,
): Promise<ChatMaintenanceResult> {
  const result: ChatMaintenanceResult = {
    partitionsCreated: 0,
    partitionsSkipped: 0,
    defaultChannels: 0,
    rechecked: 0,
  };
  const { rows: parts } = await db.withSystem("chat:maintenance", {}, (tx) =>
    tx.execute<{ created: number; skipped: number }>(
      sql`SELECT created, skipped FROM app.ensure_chat_message_partitions(3)`,
    ),
  );
  result.partitionsCreated = parts[0]?.created ?? 0;
  result.partitionsSkipped = parts[0]?.skipped ?? 0;

  const { rows: clubs } = await db.withSystem("chat:maintenance", {}, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM public.clubs ORDER BY id`),
  );
  for (const { id: clubId } of clubs) {
    // Groups without their channel yet (created before chat, or never joined since).
    const { rows: groups } = await db.withSystem("chat:maintenance", { clubId }, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT g.id FROM public.groups g
        WHERE g.club_id = ${clubId} AND g.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.chats c WHERE c.default_for_group_id = g.id)
        ORDER BY g.id LIMIT ${BATCH}`),
    );
    for (const { id } of groups) {
      await db.withSystem("chat:maintenance", { clubId }, (tx) =>
        tx.execute(sql`SELECT app.chat_sync_group(${id}::uuid)`),
      );
      result.defaultChannels++;
    }
    // The guardian rule again where children are (someone may have turned 18).
    const { rows: chats } = await db.withSystem("chat:maintenance", { clubId }, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM public.chats WHERE club_id = ${clubId} AND has_children
          AND archived_at IS NULL ORDER BY id LIMIT ${BATCH * 10}`),
    );
    const changed: string[] = [];
    for (const { id } of chats) {
      const { rows } = await db.withSystem("chat:maintenance", { clubId }, (tx) =>
        tx.execute<{ person_id: string }>(
          sql`SELECT person_id FROM app.chat_enforce_guardians(${id}::uuid)`,
        ),
      );
      result.rechecked++;
      if (rows.length > 0) changed.push(id);
    }
    await publishChanged(db, valkey, clubId, changed);
  }
  return result;
}

export function chatMaintenanceTask(db: Database, valkey?: Redis): Task {
  return async (_payload, helpers) => {
    const result = await runChatMaintenance(db, valkey);
    if (result.partitionsSkipped > 0) {
      helpers.logger.error("chat message partitions skipped (rows in the default partition)", {
        skipped: result.partitionsSkipped,
      });
    }
    helpers.logger.info("chat maintenance", { ...result });
  };
}

/**
 * The outbox handler of the chat jobs: group, role and club relationship
 * changes sync the person's chats; guardianship changes the family's.
 */
export function chatHandler(): OutboxHandler {
  return {
    name: "chat",
    types: [
      "membership.changed",
      "membership.left",
      "role.changed",
      "assignment.ended",
      "guardianship.changed",
    ],
    async handle(event, tx) {
      if (event.type === "guardianship.changed") {
        const payload = DOMAIN_EVENTS["guardianship.changed"].parse(event.payload);
        await tx.execute(sql`
          SELECT graphile_worker.add_job('chat:sync_family', ${JSON.stringify(payload)}::json,
            job_key := ${`chat:family:${payload.guardianPersonId}:${payload.wardPersonId}`},
            max_attempts := 10)`);
        return;
      }
      const { clubId, personId } = PersonPayload.parse(event.payload);
      await tx.execute(sql`
        SELECT graphile_worker.add_job('chat:sync_person',
          ${JSON.stringify({ clubId, personId })}::json,
          job_key := ${`chat:person:${clubId}:${personId}`}, max_attempts := 10)`);
    },
  };
}
