// SPDX-License-Identifier: AGPL-3.0-only
// Domain events published through the transactional outbox (packages/db
// outbox.publish) and handled by the worker. Payloads carry IDs only, never
// personal data: they are stored in the database and may appear in logs.

import { z } from "./zod.ts";

const id = z.uuid();

export const DOMAIN_EVENTS = {
  /** A person's relationships in a club changed (cache invalidation, P0.7). */
  "membership.changed": z.object({ clubId: id, personId: id }),
  /** A club was created (billing: start the trial when hosted). */
  "club.created": z.object({ clubId: id }),
  /** A club's plan, subscription status or access state changed (entitlements cache). */
  "club.entitlements.changed": z.object({ clubId: id }),
  /** Billing (P1.13): IDs only. */
  "billing.invoice.issued": z.object({ clubId: id, invoiceId: id }),
  "billing.invoice.paid": z.object({ clubId: id, invoiceId: id }),
  "billing.invoice.overdue": z.object({ clubId: id, invoiceId: id, level: z.number().int() }),
  /** A club manager chose a plan ("selected", applied by the worker) or the ledger moved it. */
  "billing.subscription.changed": z.object({
    clubId: id,
    change: z.enum([
      "selected",
      "trial_ending",
      "trial_ended",
      "past_due",
      "read_only",
      "restored",
      "renewed",
    ]),
  }),
  /** A card charge failed (part B): the first failure, and the last retry (`final`). */
  "billing.card.failed": z.object({ clubId: id, invoiceId: id, final: z.boolean() }),
  /** An operator asked to email an invoice again. */
  "billing.invoice.resend_requested": z.object({ clubId: id, invoiceId: id }),
  "role.changed": z.object({ clubId: id, personId: id }),
  /**
   * A role's permissions changed (P1.15 A2): its holders' relationship sets
   * are invalidated, and holders are told of removed permissions.
   */
  "role.updated": z.object({
    clubId: id,
    roleId: id,
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  /** Someone gave themselves a role (P1.15 A2): the other administrators and the chair are told. */
  "role.self_assigned": z.object({ clubId: id, personId: id, roleId: id }),
  /** A club role assignment was ended by an administrator (P1.15 A2): the person is told. */
  "role.unassigned": z.object({ clubId: id, personId: id, roleId: id }),
  /** Migration 0032 split the club manager's permissions (P1.15 A2): the managers are told. */
  "roles.manager_split": z.object({ clubId: id }),
  // At least two administrators (P1.15 A3): the target, every administrator
  // and the chair are told; a confirmed suspension also invalidates the
  // target's relationship sets.
  "administrator.suspension.requested": z.object({ clubId: id, suspensionId: id }),
  // Child safety in chat (P2.1 part B): the club's safeguarding officers get
  // reports and requests to read; the sender of a moderated message and a
  // muted member are told.
  "chat.report.created": z.object({ clubId: id, reportId: id }),
  "chat.report.read_requested": z.object({ clubId: id, reportId: id, readId: id }),
  "chat.message.moderated": z.object({ clubId: id, chatId: id, messageId: id, personId: id }),
  "chat.member.muted": z.object({ clubId: id, muteId: id, personId: id }),
  "administrator.suspended": z.object({ clubId: id, suspensionId: id, personId: id }),
  /** An open request was cancelled by its initiator or expired: target and initiator are told. */
  "administrator.suspension.closed": z.object({
    clubId: id,
    suspensionId: id,
    status: z.enum(["cancelled", "expired"]),
  }),
  /** Someone became an administrator (assigned, or a held role gained club.roles.manage). */
  "administrator.added": z.object({ clubId: id, personId: id }),
  /** Migration 0033: the club has fewer than two administrators and 30 days to appoint one. */
  "club.administrators.grace_started": z.object({ clubId: id }),
  /** The person left the club themselves (P1.8a): tell the managers and registrars. */
  "membership.left": z.object({ clubId: id, personId: id }),
  /**
   * A waiting-list entry was closed by the club (P1.10a: group archived;
   * P1.10b: removed by an owner, join request rejected); the applicant is told.
   */
  "waitlist.entry.closed": z.object({ clubId: id, entryId: id }),
  /** Waiting lists (P1.10b, ADR 0043): the applicant and requester are told. */
  "waitlist.entry.created": z.object({ clubId: id, entryId: id }),
  "waitlist.offer.sent": z.object({ clubId: id, entryId: id }),
  "waitlist.offer.expired": z.object({ clubId: id, entryId: id }),
  "waitlist.admitted": z.object({ clubId: id, entryId: id }),
  /** The person stepped down from a role, leader function or ownership (P1.8a). */
  "assignment.ended": z.object({
    clubId: id,
    personId: id,
    kind: z.enum(["role", "group_function", "group_owner"]),
    groupId: id.optional(),
  }),
  /** A consent was given or withdrawn (P1.8a); later consumers (photos, streams) react. */
  "consent.changed": z.object({ clubId: id, personId: id, purpose: z.string() }),
  /** A "download my data" file is ready (P1.8b): tell the requester. */
  "privacy.export.ready": z.object({ exportId: id, requestedByPersonId: id }),
  /** An account deletion or ward erasure was scheduled (P1.8b): tell those concerned. */
  "privacy.erasure.scheduled": z.object({ requestId: id }),
  /** The erasure job found a role or invoice given during the grace period (P1.8b): tell the person. */
  "privacy.erasure.blocked": z.object({ requestId: id }),
  /** A new version of the club's privacy policy took effect (P1.8a): tell the members. */
  "club.privacy_policy.published": z.object({ clubId: id, policyId: id }),
  "group.owner.changed": z.object({ clubId: id, groupId: id, personId: id }),
  /** The system revoked a calendar feed (P1.11: unused, access lost): tell its owner. */
  "calendar.feed.revoked": z.object({ feedId: id, personId: id }),
  "group.parent.changed": z.object({ clubId: id, groupId: id }),
  "guardianship.changed": z.object({ guardianPersonId: id, wardPersonId: id }),
  /** P1.12: `enabled`, `scope` and who changed it (optional: older events lack them). */
  "person.protection.changed": z.object({
    personId: id,
    clubId: id.optional(),
    enabled: z.boolean().optional(),
    scope: z.enum(["global", "club"]).optional(),
    byPersonId: id.optional(),
  }),
  /** Relationships of mergedPersonId now belong to keptPersonId (or back, when undone). */
  "person.merged": z.object({ keptPersonId: id, mergedPersonId: id, undone: z.boolean() }),
  /** Notify the old address (P1.7). */
  "account.email.changed": z.object({ accountId: id, personId: id }),
  /** Send the own-login invitation email (P1.3). */
  "account.invited": z.object({ invitationId: id, personId: id }),
  /** Send the invitation email (P1.3; also after a resend, with the new link). */
  "guardianship.invited": z.object({ invitationId: id, wardPersonId: id }),
  /** Tell the inviter their invitation was accepted (P1.3). */
  "guardianship.invitation.accepted": z.object({ invitationId: id, wardPersonId: id }),
  /** The ward reached the adult age: notify them, or their guardians without a login (P1.3). */
  "guardianship.ward.adult": z.object({ guardianshipId: id, wardPersonId: id }),
  /** The ward may now get their own login: tell this guardian once (P1.3). */
  "guardianship.ward.own_login_age": z.object({ guardianshipId: id, wardPersonId: id }),
  /** The young person ended this guardian's access at the adult age: tell the guardian (P1.3). */
  "guardianship.adult.ended": z.object({ guardianshipId: id, wardPersonId: id }),
  /** Joining (P1.1): emails to the invited person, the applicant, the managers. */
  "invitation.created": z.object({ invitationId: id, clubId: id }),
  "join_request.decided": z.object({ joinRequestId: id, clubId: id }),
  "club.manager.changed": z.object({
    clubId: id,
    personId: id,
    change: z.enum(["appointed", "removed", "handed_over", "claimed", "reassigned"]),
  }),
  "club_creation_request.decided": z.object({ requestId: id }),
  /** Member register (P1.2): every club manager hears about an export. */
  "members.exported": z.object({ exportId: id, clubId: id }),
  "members.import.finished": z.object({ importId: id, clubId: id }),
  /** Activities (P1.4): P1.7 notifies, P1.11 refreshes feeds. */
  "activity.changed": z.object({
    clubId: id,
    activityId: id,
    change: z.enum(["created", "updated", "cancelled", "restored", "deleted"]),
  }),
  "activity_series.changed": z.object({
    clubId: id,
    seriesId: id,
    change: z.enum(["created", "updated", "split"]),
  }),
  /** Responses and attendance (P1.5): P1.7 may tell leaders of a late "not attending". */
  "activity.response.changed": z.object({
    clubId: id,
    activityId: id,
    personId: id,
    change: z.enum(["set", "withdrawn"]),
  }),
  "attendance.recorded": z.object({ clubId: id, activityId: id }),
  /** Events with sign-up (P1.6): created, updated, published, cancelled, deleted. */
  "event.changed": z.object({
    clubId: id,
    eventId: id,
    change: z.enum(["created", "updated", "published", "cancelled", "deleted"]),
  }),
  /** A registration's status changed (P1.7 notifies). */
  "event.registration.changed": z.object({
    clubId: id,
    eventId: id,
    registrationId: id,
    personId: id,
  }),
  /** A place was confirmed from the waiting list or offered (mail now). */
  "event.offer.made": z.object({
    clubId: id,
    eventId: id,
    registrationId: id,
    personId: id,
    kind: z.enum(["confirmed", "offered"]),
  }),
  /** Call-ups (#19): P1.7 tells those newly called up. */
  "activity.invitees.changed": z.object({
    clubId: id,
    activityId: id,
    added: z.array(id),
    removed: z.array(id),
  }),
} as const;

export type DomainEventType = keyof typeof DOMAIN_EVENTS;
export type DomainEventPayload<T extends DomainEventType> = z.infer<(typeof DOMAIN_EVENTS)[T]>;

export const isDomainEventType = (value: string): value is DomainEventType =>
  value in DOMAIN_EVENTS;
