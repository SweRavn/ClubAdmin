// SPDX-License-Identifier: AGPL-3.0-only
// Demo billing data (P0.12, P1.13), only with BILLING_ENABLED=true: plans with
// monthly and yearly prices, SVK on a paid plan with billing details,
// invoices for the last three months (two paid, one of them late after a
// reminder; the current one open), a credit note for a duplicated Streaming
// line; IKN on the free plan without details; FIL in a trial ending in ten
// days. The seller is the fictional demo seller. With billing off the demo
// has no billing data (docs/seed-data.md).

import { eq, ledger, type LedgerSettings, sql, tables, type Tx } from "@clubadmin/db";
import { DEMO_SELLER } from "@clubadmin/server-kit";
import { periodAt } from "@clubadmin/shared";

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
        await tx.execute(sql`
          INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
          SELECT id, 'SEK', p.period, ${plan.priceMinor} * p.factor FROM billing.plans,
            (VALUES ('month', 1), ('year', 10)) AS p(period, factor)
          WHERE key = ${plan.key}
          ON CONFLICT DO NOTHING`);
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

const SETTINGS: LedgerSettings = {
  seller: DEMO_SELLER,
  invoicePrefix: "CA-",
  paymentTermsDays: 30,
  defaultPlan: "free",
};
const DAY = 86_400_000;

async function subscriptionOf(tx: Tx, clubId: string) {
  const [row] = await tx
    .select()
    .from(tables.billingSubscriptions)
    .where(eq(tables.billingSubscriptions.clubId, clubId));
  if (!row) throw new Error("demo billing: no subscription");
  return row;
}

/**
 * SVK's billing (P1.13): the treasurer's details, three monthly invoices
 * through the ledger as the daily job would have issued them, payments and
 * a credit note. Times relative to the seed's clock.
 */
export const billingInvoicesDemoStep: DemoStep = {
  name: "billing-invoices",
  async run(env, _data, core) {
    if (!env.billingEnabled) return;
    const clubId = core.ids.get("svk");
    if (!clubId) throw new Error("demo billing: no club svk");
    const now = env.clock.now;
    const zone = "Europe/Stockholm";
    await env.db.withSystem("seed:billing", { clubId }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO billing.accounts (club_id, legal_name, address, invoice_email, reference,
          invoice_locale, terms_version, terms_accepted_at)
        VALUES (${clubId}, 'Strandvikens Volleybollklubb',
          ${JSON.stringify({ street: "Strandvägen 12", postalCode: "123 45", city: "Strandviken", country: "SE" })}::jsonb,
          'kassor@strandviken.example', 'Kassören', 'sv', '2026-11', ${new Date(now.getTime() - 100 * DAY)})
        ON CONFLICT (club_id) DO NOTHING`);
      const current = periodAt(now, "month", zone);
      const periods = [
        periodAt(new Date(current.start.getTime() - 40 * DAY), "month", zone),
        periodAt(new Date(current.start.getTime() - 10 * DAY), "month", zone),
        current,
      ];
      await tx.execute(sql`
        UPDATE billing.subscriptions
        SET current_period_start = ${current.start}, current_period_end = ${current.end}
        WHERE club_id = ${clubId}`);
      const sub = await subscriptionOf(tx, clubId);
      const prices = await ledger.planPrices(tx, [sub.planId, ...sub.addOnPlanIds], "SEK", "month");
      const line = (planId: string, period: { start: Date; end: Date }) => ({
        descriptionKey: "plan.month",
        planId,
        quantity: 1,
        unitMinor: prices.get(planId) ?? 0,
        amountMinor: prices.get(planId) ?? 0,
        periodStart: period.start,
        periodEnd: period.end,
        proration: false,
      });
      // Issued 85, 55 and 25 days ago: the current one is due in five days.
      const issued = [];
      for (const [i, period] of periods.entries()) {
        const lines = [line(sub.planId, period), ...sub.addOnPlanIds.map((id) => line(id, period))];
        // The middle invoice charged Streaming twice by mistake (credited below).
        if (i === 1) lines.push(line(sub.addOnPlanIds[0]!, period));
        const at = new Date(now.getTime() - (85 - 30 * i) * DAY);
        const invoice = await ledger.issueInvoice(tx, SETTINGS, { sub, period, lines, now: at });
        if (!invoice) throw new Error("demo billing: invoice not issued");
        issued.push({ ...invoice, at });
      }
      const [first, second] = issued as [(typeof issued)[0], (typeof issued)[0]];
      await ledger.recordPayment(tx, {
        invoiceId: first.invoiceId,
        provider: "manual",
        reference: "DEMO-BG-0001",
        amountMinor: first.totalMinor,
        receivedOn: new Date(first.at.getTime() + 20 * DAY).toISOString().slice(0, 10),
        status: "succeeded",
        now: new Date(first.at.getTime() + 21 * DAY),
      });
      const credit = await ledger.issueCreditNote(tx, SETTINGS, {
        invoiceId: second.invoiceId,
        lines: [2],
        reason: "duplicate",
        now: new Date(second.at.getTime() + 5 * DAY),
      });
      // Paid three days late, after the first reminder.
      await tx.execute(sql`
        UPDATE billing.invoices SET reminder_level = 1, last_reminded_at = ${new Date(second.at.getTime() + 31 * DAY)}
        WHERE id = ${second.invoiceId}`);
      await ledger.recordPayment(tx, {
        invoiceId: second.invoiceId,
        provider: "manual",
        reference: "DEMO-BG-0002",
        amountMinor: second.totalMinor + credit.totalMinor,
        receivedOn: new Date(second.at.getTime() + 33 * DAY).toISOString().slice(0, 10),
        status: "succeeded",
        now: new Date(second.at.getTime() + 33 * DAY),
      });
    });
  },
};
