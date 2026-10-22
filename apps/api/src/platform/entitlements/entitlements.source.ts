// SPDX-License-Identifier: AGPL-3.0-only
// Where a club's entitlements come from (docs/hosting-and-billing.md):
// FlagsEntitlements with billing off (every enabled feature, no limits), or
// the billing module's PlanEntitlements with billing on. Chosen at startup.

import {
  BILLING_OFF_DEFAULTS,
  ENTITLEMENT_FEATURES,
  type EntitlementFeature,
  type EntitlementLimit,
  featureFlagName,
  type SubscriptionStatus,
} from "@clubadmin/shared";

export interface ClubEntitlementsBase {
  features: Record<EntitlementFeature, boolean>;
  limits: Record<EntitlementLimit, number | null>;
  plan: { key: string; name: string } | null;
  subscriptionStatus: SubscriptionStatus | null;
  trialEndsAt: Date | null;
}

export interface EntitlementSource {
  load(clubId: string): Promise<ClubEntitlementsBase>;
}

export const ENTITLEMENT_SOURCE = Symbol("ENTITLEMENT_SOURCE");

/** The FEATURE_* flags of the configuration: false turns a feature off everywhere. */
export function enabledFeatures(
  config: Readonly<Record<string, unknown>>,
): Record<EntitlementFeature, boolean> {
  return Object.fromEntries(
    ENTITLEMENT_FEATURES.map((feature) => [feature, config[featureFlagName(feature)] !== false]),
  ) as Record<EntitlementFeature, boolean>;
}

/** Billing off: every feature enabled by its flag, no limits, no plan. */
export class FlagsEntitlements implements EntitlementSource {
  private readonly value: ClubEntitlementsBase;

  constructor(enabled: Record<EntitlementFeature, boolean>) {
    this.value = {
      features: Object.fromEntries(
        ENTITLEMENT_FEATURES.map((f) => [f, BILLING_OFF_DEFAULTS.features[f] && enabled[f]]),
      ) as Record<EntitlementFeature, boolean>,
      limits: { ...BILLING_OFF_DEFAULTS.limits },
      plan: null,
      subscriptionStatus: null,
      trialEndsAt: null,
    };
  }

  load(): Promise<ClubEntitlementsBase> {
    return Promise.resolve(this.value);
  }
}
