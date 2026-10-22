// SPDX-License-Identifier: AGPL-3.0-only
// What a club may use (docs/hosting-and-billing.md, ADR 0013): feature keys
// and limits, asked through the API's EntitlementsService, never from the
// billing tables. With billing off every feature enabled by its FEATURE_*
// flag is granted without limits; with billing on the club's plan (plus
// add-ons) decides. Keys are strings in responses: clients ignore keys they
// do not know (ADR 0029).

import { z } from "./zod.ts";

export const ENTITLEMENT_FEATURES = [
  "chat",
  "calendar_feeds",
  "streaming",
  "documents",
  "finance",
  "sponsors",
] as const;
export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number];

export const ENTITLEMENT_LIMITS = ["members_max", "storage_gb", "streaming_hours"] as const;
export type EntitlementLimit = (typeof ENTITLEMENT_LIMITS)[number];

export const isEntitlementFeature = (value: string): value is EntitlementFeature =>
  (ENTITLEMENT_FEATURES as readonly string[]).includes(value);
export const isEntitlementLimit = (value: string): value is EntitlementLimit =>
  (ENTITLEMENT_LIMITS as readonly string[]).includes(value);

/** The environment variable that turns a feature off for the whole installation. */
export const featureFlagName = (feature: EntitlementFeature): string =>
  `FEATURE_${feature.toUpperCase()}`;

/**
 * Defaults with billing off: features on unless their FEATURE_* flag says
 * false; limits unlimited (null).
 */
export const BILLING_OFF_DEFAULTS: {
  features: Record<EntitlementFeature, boolean>;
  limits: Record<EntitlementLimit, number | null>;
} = {
  features: {
    chat: true,
    calendar_feeds: true,
    streaming: true,
    documents: true,
    finance: true,
    sponsors: true,
  },
  limits: { members_max: null, storage_gb: null, streaming_hours: null },
};

/** Whether a club can use its data: never deleted for non-payment (ADR 0013). */
export const CLUB_ACCESS_STATES = ["active", "read_only", "suspended"] as const;
export type ClubAccessState = (typeof CLUB_ACCESS_STATES)[number];

export const SUBSCRIPTION_STATUSES = [
  "trial",
  "active",
  "past_due",
  "read_only",
  "cancelled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Allowed status changes (billing module); cancelled can be reactivated by an operator. */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  trial: ["active", "past_due", "cancelled"],
  active: ["past_due", "cancelled"],
  past_due: ["active", "read_only", "cancelled"],
  read_only: ["active", "cancelled"],
  cancelled: ["active", "trial"],
};

/** The club access state that follows from a subscription status. */
export const accessStateForSubscription = (status: SubscriptionStatus): ClubAccessState =>
  status === "read_only" ? "read_only" : "active";

export const EntitlementsResponseSchema = z
  .object({
    /** Feature key → granted. */
    features: z
      .record(z.string(), z.boolean())
      .openapi({ example: { chat: true, streaming: false } }),
    /** Limit key → value, null for unlimited. */
    limits: z
      .record(z.string(), z.number().int().nullable())
      .openapi({ example: { members_max: 250, storage_gb: null } }),
    accessState: z.string().openapi({ example: "active" }),
    billingEnabled: z.boolean(),
    /** The club's plan (billing on). */
    plan: z.object({ key: z.string(), name: z.string() }).nullable(),
    subscriptionStatus: z.string().nullable().openapi({ example: "trial" }),
    trialEndsAt: z.iso.datetime().nullable(),
  })
  .openapi("Entitlements");
export type EntitlementsResponse = z.infer<typeof EntitlementsResponseSchema>;

export const ClubAccessStateRequestSchema = z
  .object({ accessState: z.enum(CLUB_ACCESS_STATES) })
  .openapi("ClubAccessStateRequest");
export type ClubAccessStateRequest = z.infer<typeof ClubAccessStateRequestSchema>;

export const ClubAccessStateResponseSchema = z
  .object({ clubId: z.uuid(), accessState: z.string() })
  .openapi("ClubAccessState");

// Billing (operators; routes exist only with BILLING_ENABLED=true).

export const PlanSchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    kind: z.string().openapi({ example: "base" }),
    currency: z.string().openapi({ example: "SEK" }),
    /** Price per period in minor units (öre, cents). */
    priceMinor: z.number().int(),
    period: z.string().openapi({ example: "month" }),
    active: z.boolean(),
    features: z.record(z.string(), z.boolean()),
    limits: z.record(z.string(), z.number().int().nullable()),
  })
  .openapi("Plan");
export type Plan = z.infer<typeof PlanSchema>;

export const PlanListSchema = z.object({ plans: z.array(PlanSchema) }).openapi("PlanList");

export const SubscriptionSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    planKey: z.string(),
    addOns: z.array(z.string()),
    status: z.string().openapi({ example: "active" }),
    trialEndsAt: z.iso.datetime().nullable(),
    currentPeriodStart: z.iso.datetime().nullable(),
    currentPeriodEnd: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
  })
  .openapi("Subscription");
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscriptionResponseSchema = z
  .object({ subscription: SubscriptionSchema.nullable() })
  .openapi("SubscriptionResponse");

export const AssignPlanRequestSchema = z
  .object({
    planKey: z.string().min(1).max(64),
    addOns: z.array(z.string().min(1).max(64)).max(20).default([]),
  })
  .openapi("AssignPlanRequest");
export type AssignPlanRequest = z.infer<typeof AssignPlanRequestSchema>;

export const SubscriptionStatusRequestSchema = z
  .object({ status: z.enum(SUBSCRIPTION_STATUSES) })
  .openapi("SubscriptionStatusRequest");
export type SubscriptionStatusRequest = z.infer<typeof SubscriptionStatusRequestSchema>;
