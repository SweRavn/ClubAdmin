// SPDX-License-Identifier: AGPL-3.0-only
// Plans and subscriptions (BILLING_ENABLED=true; docs/hosting-and-billing.md).
// Operators assign plans and change subscription status; a status change
// sets the club's access state (read_only on non-payment, never deletion).
// Every change is audited, publishes club.entitlements.changed and
// invalidates the entitlements cache, so it applies from the next request.

import { type ActorContext, audit, type Database, outbox, type TenantContext } from "@clubadmin/db";
import {
  accessStateForSubscription,
  type Plan,
  type Subscription,
  SUBSCRIPTION_TRANSITIONS,
  type SubscriptionStatus,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./billing.repository.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;

export class BillingService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly cache: Pick<EntitlementsCache<unknown>, "invalidate">;

  constructor(
    db: Database,
    deps: { clubs: ClubsService; cache: Pick<EntitlementsCache<unknown>, "invalidate"> },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.cache = deps.cache;
  }

  /** The catalogue with what each plan grants (operators). */
  listPlans(context: ActorContext): Promise<Plan[]> {
    return this.db.withActor(context, async (tx) => {
      const plans = await repo.listPlans(tx);
      const rows = await repo.planEntitlements(
        tx,
        plans.map((p) => p.id),
      );
      return plans.map((plan) => {
        const mine = rows.filter((r) => r.planId === plan.id);
        return {
          id: plan.id,
          key: plan.key,
          name: plan.name,
          kind: plan.kind,
          currency: plan.currency,
          priceMinor: plan.priceMinor,
          period: plan.period,
          active: plan.active,
          features: Object.fromEntries(
            mine.filter((r) => r.kind === "feature").map((r) => [r.key, r.enabled === true]),
          ),
          limits: Object.fromEntries(
            mine.filter((r) => r.kind === "limit").map((r) => [r.key, r.limitValue]),
          ),
        };
      });
    });
  }

  /** The club's subscription (club managers, treasurers and operators; others see none). */
  getSubscription(context: TenantContext): Promise<Subscription | null> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findSubscription(tx, context.clubId);
      if (!row) return null;
      const plans = await repo.findPlansById(tx, [row.planId, ...row.addOnPlanIds]);
      return this.toSubscription(row, plans);
    });
  }

  /** Puts the club on a plan (operators): creates an active subscription or changes its plan and add-ons. */
  async assignPlan(
    context: TenantContext,
    planKey: string,
    addOns: readonly string[],
  ): Promise<Subscription> {
    const result = await this.db.withTenant(context, async (tx) => {
      const plans = await repo.findPlansByKey(tx, [planKey, ...addOns]);
      const base = plans.find((p) => p.key === planKey && p.kind === "base" && p.active);
      const extras = addOns.map((key) =>
        plans.find((p) => p.key === key && p.kind === "add_on" && p.active),
      );
      if (!base || extras.some((p) => !p)) throw new DomainError("plan_not_found");
      const addOnPlanIds = extras.map((p) => p?.id ?? "");
      const current = await repo.lockSubscription(tx, context.clubId);
      if (current) {
        await repo.updateSubscription(tx, context.clubId, { planId: base.id, addOnPlanIds });
        await audit.record(tx, {
          action: "billing.subscription.plan.changed",
          resourceType: "subscription",
          resourceId: current.id,
          changedFields: ["plan_id", "add_on_plan_ids"],
        });
      } else {
        const id = await repo.insertSubscription(tx, {
          clubId: context.clubId,
          planId: base.id,
          addOnPlanIds,
          status: "active",
          currentPeriodStart: new Date(),
        });
        await audit.record(tx, {
          action: "billing.subscription.created",
          resourceType: "subscription",
          resourceId: id,
        });
      }
      await outbox.publish(tx, "club.entitlements.changed", { clubId: context.clubId });
      const row = await repo.findSubscription(tx, context.clubId);
      if (!row) throw new DomainError("no_subscription");
      return this.toSubscription(row, plans);
    });
    await this.cache.invalidate(context.clubId);
    return result;
  }

  /** Moves the subscription to another status (operators; P1.13 adds dunning). */
  async changeStatus(context: TenantContext, status: SubscriptionStatus): Promise<Subscription> {
    const result = await this.db.withTenant(context, async (tx) => {
      const current = await repo.lockSubscription(tx, context.clubId);
      if (!current) throw new DomainError("no_subscription");
      if (current.status !== status) {
        if (!SUBSCRIPTION_TRANSITIONS[current.status].includes(status)) {
          throw new DomainError("subscription_transition_invalid");
        }
        await repo.updateSubscription(tx, context.clubId, {
          status,
          cancelledAt: status === "cancelled" ? new Date() : null,
          ...(status === "trial" ? { trialEndsAt: current.trialEndsAt ?? new Date() } : {}),
        });
        await audit.record(tx, {
          action: "billing.subscription.status.changed",
          resourceType: "subscription",
          resourceId: current.id,
          changedFields: ["status"],
        });
        await this.clubs.setAccessStateInTx(tx, context.clubId, accessStateForSubscription(status));
        await outbox.publish(tx, "club.entitlements.changed", { clubId: context.clubId });
      }
      const row = await repo.findSubscription(tx, context.clubId);
      if (!row) throw new DomainError("no_subscription");
      const plans = await repo.findPlansById(tx, [row.planId, ...row.addOnPlanIds]);
      return this.toSubscription(row, plans);
    });
    await this.cache.invalidate(context.clubId);
    return result;
  }

  private toSubscription(row: repo.SubscriptionRow, plans: readonly repo.PlanRow[]): Subscription {
    const key = (id: string) => plans.find((p) => p.id === id)?.key ?? id;
    return {
      id: row.id,
      clubId: row.clubId,
      planKey: key(row.planId),
      addOns: row.addOnPlanIds.map(key),
      status: row.status,
      trialEndsAt: iso(row.trialEndsAt),
      currentPeriodStart: iso(row.currentPeriodStart),
      currentPeriodEnd: iso(row.currentPeriodEnd),
      cancelledAt: iso(row.cancelledAt),
    };
  }
}
