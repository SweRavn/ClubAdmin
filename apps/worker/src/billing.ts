// SPDX-License-Identifier: AGPL-3.0-only
// Billing in the worker (P0.12; loaded only with BILLING_ENABLED=true):
// a trial for every new club on the hosted service, and the monthly
// invoicing job as a placeholder until P1.13 (InvoiceGenerator).
// Entitlements caches of the API instances are invalidated through Valkey.

import { audit, type OutboxHandler, sql } from "@clubadmin/db";
import { DOMAIN_EVENTS, ENTITLEMENTS_INVALIDATE_CHANNEL } from "@clubadmin/shared";
import type { Task } from "graphile-worker";
import type { Redis } from "ioredis";

/** club.entitlements.changed: drop the club's entitlements on every API instance. */
export function entitlementsCacheHandler(valkey: Redis): OutboxHandler {
  return {
    name: "entitlements-cache",
    types: ["club.entitlements.changed"],
    async handle(event) {
      const { clubId } = DOMAIN_EVENTS["club.entitlements.changed"].parse(event.payload);
      // Publishing twice is harmless: it only forces a reload.
      await valkey.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, clubId);
    },
  };
}

/**
 * club.created on the hosted service: the club starts a trial on the default
 * plan (BILLING_DEFAULT_PLAN) for BILLING_TRIAL_DAYS. Idempotent: a club that
 * already has a subscription keeps it.
 */
export function billingTrialHandler(options: {
  defaultPlan: string;
  trialDays: number;
  valkey?: Redis | undefined;
}): OutboxHandler {
  return {
    name: "billing-trial",
    types: ["club.created"],
    async handle(event, tx) {
      const { clubId } = DOMAIN_EVENTS["club.created"].parse(event.payload);
      await tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO billing.subscriptions (club_id, plan_id, status, trial_ends_at, current_period_start)
        SELECT ${clubId}, p.id, 'trial', now() + make_interval(days => ${options.trialDays}), now()
        FROM billing.plans p
        WHERE p.key = ${options.defaultPlan} AND p.kind = 'base'
        ON CONFLICT (club_id) DO NOTHING
        RETURNING id`);
      const id = rows[0]?.id;
      if (!id) return;
      await audit.record(tx, {
        action: "billing.subscription.created",
        resourceType: "subscription",
        resourceId: id,
      });
      await options.valkey?.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, clubId);
    },
  };
}

/**
 * Monthly invoicing (1st of the month): a placeholder until P1.13 plugs in an
 * InvoiceGenerator and a PaymentProvider. Scheduled only with billing on.
 */
export const generateInvoicesTask: Task = (_payload, helpers) => {
  helpers.logger.info("billing: invoicing is not implemented yet (P1.13)");
};
