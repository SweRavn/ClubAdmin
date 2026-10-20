// SPDX-License-Identifier: AGPL-3.0-only
// Handlers for domain events from the transactional outbox. Each runs at most
// once per event; its database work commits together with its delivery
// record. External side effects (email, push) must be idempotent: use
// event.idempotencyKey. The first handlers arrive with P0.7 (cache invalidation).
import type { OutboxHandler } from "@clubadmin/db";

export const outboxHandlers: OutboxHandler[] = [];
