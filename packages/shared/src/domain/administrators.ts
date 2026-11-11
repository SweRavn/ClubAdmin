// SPDX-License-Identifier: AGPL-3.0-only
// At least two administrators; suspending one (P1.15 A3, ADR 0046). An
// administrator holds club.roles.manage through any role; they count when
// they have an account and are adults by the club's country pack. With fewer
// than two who count, a club outside its grace period adds no members.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

/** Hours an unconfirmed suspension request stays open. */
export const SUSPENSION_REQUEST_HOURS = 72;
/** Days of grace for an existing club with fewer than two administrators. */
export const ADMINISTRATORS_GRACE_DAYS = 30;
/** Days an operator may add to a club's grace period (once). */
export const ADMINISTRATORS_GRACE_EXTENSION_DAYS = 30;
/** Days of role and permission changes the suspension dialog lists for review. */
export const SUSPENSION_REVIEW_DAYS = 14;

export const SUSPENSION_REASONS = ["compromised", "left_task", "other"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export const SUSPENSION_STATUSES = ["requested", "confirmed", "cancelled", "expired"] as const;
export type SuspensionStatus = (typeof SUSPENSION_STATUSES)[number];

/**
 * The club's state: `ok` (three or more), `recommend_third` (exactly two),
 * `grace` (fewer than two, may still add members until `graceUntil`),
 * `needs_administrators` (fewer than two: no new members).
 */
export const ADMINISTRATORS_STATES = [
  "ok",
  "recommend_third",
  "grace",
  "needs_administrators",
] as const;
export type AdministratorsState = (typeof ADMINISTRATORS_STATES)[number];

export const AdministratorSuspensionSchema = z
  .object({
    id: z.uuid(),
    target: PersonSummarySchema,
    requestedBy: PersonSummarySchema,
    confirmedBy: PersonSummarySchema.nullable(),
    reason: z.enum(SUSPENSION_REASONS),
    note: z.string().nullable(),
    demote: z.boolean(),
    status: z.enum(SUSPENSION_STATUSES),
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("AdministratorSuspension");
export type AdministratorSuspension = z.infer<typeof AdministratorSuspensionSchema>;

export const AdministratorSchema = z
  .object({
    person: PersonSummarySchema,
    /** Counts towards the minimum: an account and an adult. */
    counts: z.boolean(),
    /** Why not: no account (or erased), or a minor. */
    reason: z.enum(["no_account", "minor"]).nullable(),
    /** The roles through which the person holds club.roles.manage. */
    roleIds: z.array(z.uuid()),
  })
  .openapi("Administrator");
export type Administrator = z.infer<typeof AdministratorSchema>;

export const AdministratorsOverviewSchema = z
  .object({
    items: z.array(AdministratorSchema),
    /** Distinct people who count. */
    count: z.number().int(),
    state: z.enum(ADMINISTRATORS_STATES),
    graceUntil: z.iso.datetime().nullable(),
    /** An operator extended the grace period (once per club). */
    graceExtended: z.boolean(),
    /** Open requests (status requested). */
    suspensions: z.array(AdministratorSuspensionSchema),
  })
  .openapi("AdministratorsOverview");
export type AdministratorsOverview = z.infer<typeof AdministratorsOverviewSchema>;

export const StartSuspensionSchema = z
  .object({
    reason: z.enum(SUSPENSION_REASONS),
    note: z.string().trim().max(500).optional(),
    /**
     * Also end every other club role and group leader role (membership
     * stays); the default is on for `compromised`.
     */
    demote: z.boolean().optional(),
  })
  .openapi("StartSuspension");
export type StartSuspensionInput = z.input<typeof StartSuspensionSchema>;

export const SuspensionResultSchema = z
  .object({
    suspension: AdministratorSuspensionSchema,
    /** Assignments ended on confirmation (club roles, group leader roles). */
    endedRoles: z.number().int(),
    endedGroupRoles: z.number().int(),
  })
  .openapi("SuspensionResult");
export type SuspensionResult = z.infer<typeof SuspensionResultSchema>;

/** The target's role and permission changes of the last days, for review. */
export const SuspensionReviewItemSchema = z
  .object({
    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    occurredAt: z.iso.datetime(),
  })
  .openapi("SuspensionReviewItem");

export const SuspensionReviewSchema = z
  .object({ items: z.array(SuspensionReviewItemSchema) })
  .openapi("SuspensionReview");
export type SuspensionReview = z.infer<typeof SuspensionReviewSchema>;

export const AdministratorParamsSchema = z.object({ clubId: z.uuid(), personId: z.uuid() });
export const SuspensionParamsSchema = z.object({ clubId: z.uuid(), suspensionId: z.uuid() });

export const GraceExtensionSchema = z
  .object({ graceUntil: z.iso.datetime() })
  .openapi("GraceExtension");
export type GraceExtension = z.infer<typeof GraceExtensionSchema>;
