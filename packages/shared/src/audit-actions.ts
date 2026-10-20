// SPDX-License-Identifier: AGPL-3.0-only
// Registered audit actions (docs/security.md, "Audit"). Every semantic audit
// event uses one of these names: <resource>.<what happened>.

export const AUDIT_ACTIONS = [
  "account.created",
  "account.email.changed",
  "person.created",
  "person.updated",
  "person.protection.changed",
  "person.protected.viewed",
  "person.merged",
  "club.created",
  "club.settings.updated",
  "club.role.assigned",
  "club.role.ended",
  "club.manager.handover.proposed",
  "club.manager.handover.accepted",
  "group.created",
  "group.updated",
  "group.archived",
  "group.owner.added",
  "group.owner.removed",
  "membership.created",
  "membership.ended",
  "group.membership.created",
  "group.membership.ended",
  "guardianship.created",
  "guardianship.updated",
  "guardianship.ended",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const isAuditAction = (value: string): value is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(value);
