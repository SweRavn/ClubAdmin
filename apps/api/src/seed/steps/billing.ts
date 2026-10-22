// SPDX-License-Identifier: AGPL-3.0-only
// Demo billing data (P0.12), only with BILLING_ENABLED=true: plans, SVK on a
// paid plan, IKN on the free plan, FIL in a trial ending in 10 days. With
// billing off the demo has no billing data (docs/seed-data.md).

import { sql } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

/** Plans of the demo: key, name, kind, price (öre per month), features, limits. */
const PLANS = [
  {
    key: "free",
    name: "Free",
    kind: "base",
    priceMinor: 0,
    features: ["chat", "calendar_feeds"],
    limits: { members_max: 50, storage_gb: 1, streaming_hours: 0 },
  },
  {
    key: "standard",
    name: "Standard",
    kind: "base",
    priceMinor: 49_900,
    features: ["chat", "calendar_feeds", "documents", "finance", "sponsors"],
    limits: { members_max: 1000, storage_gb: 50, streaming_hours: 0 },
  },
  {
    key: "streaming",
    name: "Streaming",
    kind: "add_on",
    priceMinor: 19_900,
    features: ["streaming"],
    limits: { streaming_hours: 40 },
  },
] as const;

const SUBSCRIPTIONS = [
  { club: "svk", plan: "standard", addOns: ["streaming"], status: "active", trialDays: null },
  { club: "ikn", plan: "free", addOns: [], status: "active", trialDays: null },
  { club: "fil", plan: "standard", addOns: [], status: "trial", trialDays: 10 },
] as const;

export const billingDemoStep: DemoStep = {
  name: "billing",
  async run(env, _data, core) {
    if (!env.billingEnabled) return;
    await env.db.withSystem("seed:billing", {}, async (tx) => {
      for (const plan of PLANS) {
        await tx.execute(sql`
          INSERT INTO billing.plans (key, name, kind, currency, price_minor)
          VALUES (${plan.key}, ${plan.name}, ${plan.kind}, 'SEK', ${plan.priceMinor})
          ON CONFLICT (key) DO NOTHING`);
        for (const feature of plan.features) {
          await tx.execute(sql`
            INSERT INTO billing.plan_entitlements (plan_id, key, kind, enabled)
            SELECT id, ${feature}, 'feature', true FROM billing.plans WHERE key = ${plan.key}
            ON CONFLICT (plan_id, key) DO NOTHING`);
        }
        for (const [limit, value] of Object.entries(plan.limits)) {
          await tx.execute(sql`
            INSERT INTO billing.plan_entitlements (plan_id, key, kind, limit_value)
            SELECT id, ${limit}, 'limit', ${value} FROM billing.plans WHERE key = ${plan.key}
            ON CONFLICT (plan_id, key) DO NOTHING`);
        }
      }
    });
    for (const s of SUBSCRIPTIONS) {
      const clubId = core.ids.get(s.club);
      if (!clubId) throw new Error(`demo billing: no club ${s.club}`);
      await env.db.withSystem("seed:billing", { clubId }, (tx) =>
        // The worker may already have started a trial for the new club.
        tx.execute(sql`
          INSERT INTO billing.subscriptions (club_id, plan_id, add_on_plan_ids, status, trial_ends_at, current_period_start)
          SELECT ${clubId}, p.id,
                 ARRAY(SELECT a.id FROM billing.plans a WHERE a.key = ANY (${`{${s.addOns.join(",")}}`}::text[])),
                 ${s.status},
                 CASE WHEN ${s.trialDays}::int IS NULL THEN NULL ELSE now() + make_interval(days => ${s.trialDays}::int) END,
                 date_trunc('month', now())
          FROM billing.plans p WHERE p.key = ${s.plan}
          ON CONFLICT (club_id) DO UPDATE SET plan_id = EXCLUDED.plan_id,
            add_on_plan_ids = EXCLUDED.add_on_plan_ids, status = EXCLUDED.status,
            trial_ends_at = EXCLUDED.trial_ends_at, current_period_start = EXCLUDED.current_period_start`),
      );
    }
  },
};
