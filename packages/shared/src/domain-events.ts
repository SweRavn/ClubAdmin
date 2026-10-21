// SPDX-License-Identifier: AGPL-3.0-only
// Domain events published through the transactional outbox (packages/db
// outbox.publish) and handled by the worker. Payloads carry IDs only, never
// personal data: they are stored in the database and may appear in logs.

import { z } from "./zod.ts";

const id = z.uuid();

export const DOMAIN_EVENTS = {
  /** A person's relationships in a club changed (cache invalidation, P0.7). */
  "membership.changed": z.object({ clubId: id, personId: id }),
  "role.changed": z.object({ clubId: id, personId: id }),
  "group.owner.changed": z.object({ clubId: id, groupId: id, personId: id }),
  "group.parent.changed": z.object({ clubId: id, groupId: id }),
  "guardianship.changed": z.object({ guardianPersonId: id, wardPersonId: id }),
  "person.protection.changed": z.object({ personId: id, clubId: id.optional() }),
  /** Relationships of mergedPersonId now belong to keptPersonId (or back, when undone). */
  "person.merged": z.object({ keptPersonId: id, mergedPersonId: id, undone: z.boolean() }),
  /** Notify the old address (P1.7). */
  "account.email.changed": z.object({ accountId: id, personId: id }),
  /** Send the own-login invitation email (P1.7). */
  "account.invited": z.object({ invitationId: id, personId: id }),
  /** Send the invitation email (P1.7). */
  "guardianship.invited": z.object({ invitationId: id, wardPersonId: id }),
  /** The ward reached the adult age: notify them and their guardians (P1.7). */
  "guardianship.ward.adult": z.object({ guardianshipId: id, wardPersonId: id }),
} as const;

export type DomainEventType = keyof typeof DOMAIN_EVENTS;
export type DomainEventPayload<T extends DomainEventType> = z.infer<(typeof DOMAIN_EVENTS)[T]>;

export const isDomainEventType = (value: string): value is DomainEventType =>
  value in DOMAIN_EVENTS;
