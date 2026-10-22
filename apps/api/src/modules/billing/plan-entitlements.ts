// SPDX-License-Identifier: AGPL-3.0-only
// Entitlements from the club's plan plus add-ons (BILLING_ENABLED=true): a
// feature is granted if the plan or an add-on enables it; a limit is the
// highest value among them (null: unlimited; a limit no plan sets is
// unlimited). Without a subscription, or a cancelled one, the configured
// default plan applies. FEATURE_*=false still wins (EntitlementsService).

import type { Database } from "@clubadmin/db";
import {
  ENTITLEMENT_FEATURES,
  ENTITLEMENT_LIMITS,
  type EntitlementFeature,
  type EntitlementLimit,
  isEntitlementFeature,
  isEntitlementLimit,
} from "@clubadmin/shared";

import type {
  ClubEntitlementsBase,
  EntitlementSource,
} from "../../platform/entitlements/entitlements.source.ts";
import * as repo from "./billing.repository.ts";

export class PlanEntitlements implements EntitlementSource {
  private readonly db: Database;
  private readonly defaultPlan: string;

  constructor(db: Database, defaultPlan: string) {
    this.db = db;
    this.defaultPlan = defaultPlan;
  }

  load(clubId: string): Promise<ClubEntitlementsBase> {
    return this.db.withSystem("entitlements:plan", { clubId }, async (tx) => {
      const subscription = await repo.findSubscription(tx, clubId);
      const current = subscription && subscription.status !== "cancelled" ? subscription : null;
      const plans = current
        ? await repo.findPlansById(tx, [current.planId, ...current.addOnPlanIds])
        : await repo.findPlansByKey(tx, [this.defaultPlan]);
      const base = current ? plans.find((p) => p.id === current.planId) : plans[0];
      const rows = await repo.planEntitlements(
        tx,
        plans.map((p) => p.id),
      );

      const features = Object.fromEntries(ENTITLEMENT_FEATURES.map((f) => [f, false])) as Record<
        EntitlementFeature,
        boolean
      >;
      const limits = Object.fromEntries(ENTITLEMENT_LIMITS.map((l) => [l, null])) as Record<
        EntitlementLimit,
        number | null
      >;
      const limitSeen = new Set<EntitlementLimit>();
      for (const row of rows) {
        if (row.kind === "feature" && isEntitlementFeature(row.key)) {
          features[row.key] ||= row.enabled === true;
        } else if (row.kind === "limit" && isEntitlementLimit(row.key)) {
          const previous = limits[row.key];
          const value = row.limitValue;
          // Unlimited (null) wins over any number; otherwise the highest value.
          limits[row.key] = !limitSeen.has(row.key)
            ? value
            : previous === null || value === null
              ? null
              : Math.max(previous, value);
          limitSeen.add(row.key);
        }
      }
      return {
        features,
        limits,
        plan: base ? { key: base.key, name: base.name } : null,
        subscriptionStatus: subscription?.status ?? null,
        trialEndsAt: subscription?.trialEndsAt ?? null,
      };
    });
  }
}
