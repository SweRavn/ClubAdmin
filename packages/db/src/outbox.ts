// SPDX-License-Identifier: AGPL-3.0-only
// Transactional outbox. outbox.publish writes the event in the caller's
// transaction; a trigger enqueues a worker job in the same transaction, so an
// event is dispatched if and only if the change committed. The worker calls
// outbox.dispatch, which runs each handler at most once per event: the
// handler's database work and its delivery record commit together.

import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type DomainEventType,
  uuidv7,
} from "@clubadmin/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Database, Tx } from "./database.ts";
import { outboxDeliveries, outboxEvents } from "./infra/tables.ts";

export interface OutboxEvent<T extends DomainEventType = DomainEventType> {
  id: string;
  type: T;
  clubId: string | null;
  payload: DomainEventPayload<T>;
  idempotencyKey: string;
}

export interface OutboxHandler {
  /** Stable name; deliveries are recorded per handler name. */
  name: string;
  types: readonly DomainEventType[];
  /** Runs in the dispatch transaction. External side effects must be idempotent (use event.idempotencyKey). */
  handle(event: OutboxEvent, tx: Tx): Promise<void>;
}

async function publish<T extends DomainEventType>(
  tx: Tx,
  type: T,
  payload: DomainEventPayload<T>,
  options: { idempotencyKey?: string } = {},
): Promise<string> {
  const parsed = DOMAIN_EVENTS[type].parse(payload) as DomainEventPayload<T>;
  const id = uuidv7();
  await tx.execute(sql`
    INSERT INTO outbox.events (id, type, club_id, payload, idempotency_key)
    VALUES (${id}, ${type}, app.current_club_id(), ${JSON.stringify(parsed)}::jsonb, ${options.idempotencyKey ?? id})
    ON CONFLICT (idempotency_key) DO NOTHING`);
  return id;
}

export type DispatchResult = "dispatched" | "already-done" | "not-found";

async function dispatch(
  db: Database,
  eventId: string,
  handlers: readonly OutboxHandler[],
): Promise<DispatchResult> {
  return db.withSystem("outbox:dispatch", {}, async (tx) => {
    // Lock the event, so concurrent duplicate jobs wait instead of running handlers twice.
    const [event] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventId))
      .for("update");
    if (!event) return "not-found";
    if (event.status === "done") return "already-done";

    const delivered = new Set(
      (await tx.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, eventId))).map(
        (d) => d.handler,
      ),
    );
    const outboxEvent = {
      id: event.id,
      type: event.type as DomainEventType,
      clubId: event.clubId,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    } as OutboxEvent;
    for (const handler of handlers) {
      if (!handler.types.includes(outboxEvent.type) || delivered.has(handler.name)) continue;
      await handler.handle(outboxEvent, tx);
      await tx
        .insert(outboxDeliveries)
        .values({ eventId, handler: handler.name, deliveredAt: new Date() });
    }
    await tx
      .update(outboxEvents)
      .set({
        status: "done",
        dispatchedAt: new Date(),
        attempts: sql`${outboxEvents.attempts} + 1`,
      })
      .where(eq(outboxEvents.id, eventId));
    return "dispatched";
  });
}

/** Records a failed attempt (in its own transaction, since the dispatch rolled back). */
async function recordFailure(
  db: Database,
  eventId: string,
  error: unknown,
  permanent: boolean,
): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  await db.withSystem("outbox:dispatch", {}, (tx) =>
    tx
      .update(outboxEvents)
      .set({
        attempts: sql`${outboxEvents.attempts} + 1`,
        lastError: message.slice(0, 1000),
        ...(permanent ? { status: "failed" as const } : {}),
      })
      .where(and(eq(outboxEvents.id, eventId), sql`${outboxEvents.status} <> 'done'`)),
  );
}

export const outbox = { publish, dispatch, recordFailure };
