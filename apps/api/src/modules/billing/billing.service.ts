// SPDX-License-Identifier: AGPL-3.0-only
// Plans, subscriptions and invoices (BILLING_ENABLED=true; P0.12, P1.13,
// docs/hosting-and-billing.md, ADR 0045).
//
// Club managers choose a plan (MFA, terms accepted): the selection is
// written to the subscription's selection columns and applied by the worker
// (at once for upgrades and a paid period started during the trial, at the
// trial's or the period's end otherwise). Club managers and treasurers keep
// the billing details and read invoices. Operators assign plans, change the
// status (a restriction they set is never lifted by a payment), extend
// trials, manage the catalogue, record bank payments and issue credit notes
// through the ledger (@clubadmin/db). Every change is audited; plan, status
// and access changes publish club.entitlements.changed and invalidate the
// entitlements cache.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  ledger,
  LedgerError,
  type LedgerSettings,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import {
  accessStateForSubscription,
  type BillingAccount,
  type BillingAccountInput,
  BillingAccountInputSchema,
  type ClubPlans,
  type CreatePlanInput,
  type CreditNoteInput,
  type InvoiceDetail,
  type InvoicePage,
  type InvoiceSummary,
  type Plan,
  type PlanOffer,
  type RecordPaymentInput,
  type SelectPlanInput,
  SelectPlanSchema,
  type Subscription,
  SUBSCRIPTION_TRANSITIONS,
  type SubscriptionStatus,
  type UpdatePlanInput,
  vatFor,
  vatOf,
} from "@clubadmin/shared";

import { DomainError, type DomainErrorCode } from "../../platform/domain/domain-error.ts";
import type { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./billing.repository.ts";

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
const PAGE_SIZE = 50;
const PDF_SECONDS = 5 * 60;

export interface BillingOptions {
  settings: LedgerSettings;
  storage: ObjectStorage | null;
  termsVersion: string;
  termsUrl: string | null;
}

/** Ledger failures as domain errors (codes, never values). */
async function ledgerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LedgerError) throw new DomainError(error.code as DomainErrorCode);
    throw error;
  }
}

export class BillingService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly cache: Pick<EntitlementsCache<unknown>, "invalidate">;
  private readonly options: BillingOptions | null;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      cache: Pick<EntitlementsCache<unknown>, "invalidate">;
      options?: BillingOptions | null;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.cache = deps.cache;
    this.options = deps.options ?? null;
  }

  private get settings(): BillingOptions {
    if (!this.options) throw new Error("billing settings are not configured");
    return this.options;
  }

  // --- Catalogue ------------------------------------------------------------------------

  /** The catalogue with prices and what each plan grants (operators). */
  listPlans(context: ActorContext): Promise<Plan[]> {
    return this.db.withActor(context, async (tx) => {
      const plans = await repo.listPlans(tx);
      const ids = plans.map((p) => p.id);
      const [rows, prices] = await Promise.all([
        repo.planEntitlements(tx, ids),
        repo.activePrices(tx, ids),
      ]);
      return plans.map((plan) => ({
        ...this.planBase(plan, rows),
        prices: prices
          .filter((p) => p.planId === plan.id)
          .map((p) => ({ currency: p.currency, period: p.period, priceMinor: p.priceMinor })),
      }));
    });
  }

  private planBase(plan: repo.PlanRow, rows: readonly repo.PlanEntitlementRow[]) {
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
  }

  /** A new plan or add-on with prices and entitlements (operators). */
  async createPlan(context: ActorContext, input: CreatePlanInput): Promise<Plan> {
    const id = await this.db.withActor(context, async (tx) => {
      if ((await repo.findPlansByKey(tx, [input.key])).length > 0) {
        throw new DomainError("plan_key_taken");
      }
      const first = input.prices[0]!;
      const planId = await repo.insertPlan(tx, {
        key: input.key,
        name: input.name,
        kind: input.kind,
        currency: first.currency,
        priceMinor: first.priceMinor,
        period: first.period,
      });
      for (const price of input.prices) await repo.insertPrice(tx, { planId, ...price });
      await repo.setPlanEntitlements(tx, planId, input.features ?? {}, input.limits ?? {});
      await audit.record(tx, {
        action: "billing.plan.created",
        resourceType: "plan",
        resourceId: planId,
      });
      return planId;
    });
    return this.planById(context, id);
  }

  /** Name, active, entitlements and prices (added or deactivated, never edited). */
  async updatePlan(context: ActorContext, planId: string, input: UpdatePlanInput): Promise<Plan> {
    await this.db.withActor(context, async (tx) => {
      const [plan] = await repo.findPlansById(tx, [planId]);
      if (!plan) throw new DomainError("plan_not_found");
      await repo.updatePlan(tx, planId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      });
      if (input.features || input.limits) {
        await repo.setPlanEntitlements(tx, planId, input.features ?? {}, input.limits ?? {});
      }
      for (const price of input.removePrices ?? []) {
        await repo.deactivatePrice(tx, planId, price.currency, price.period);
      }
      for (const price of input.addPrices ?? []) await repo.insertPrice(tx, { planId, ...price });
      await audit.record(tx, {
        action: "billing.plan.updated",
        resourceType: "plan",
        resourceId: planId,
        changedFields: Object.keys(input),
      });
    });
    return this.planById(context, planId);
  }

  private async planById(context: ActorContext, planId: string): Promise<Plan> {
    const plan = (await this.listPlans(context)).find((p) => p.id === planId);
    if (!plan) throw new DomainError("plan_not_found");
    return plan;
  }

  /** Paid plans need a buyer the seller can invoice (decision 5: the seller's country). */
  private paidPlansAvailable(country: string): boolean {
    return country.toUpperCase() === this.settings.settings.seller.address.country.toUpperCase();
  }

  /** The plans a club can choose, with prices in its currency excluding and including VAT. */
  clubPlans(context: TenantContext): Promise<ClubPlans> {
    return this.db.withTenant(context, async (tx) => {
      const facts = await this.clubFacts(tx, context.clubId);
      const plans = (await repo.listPlans(tx)).filter((p) => p.active);
      const ids = plans.map((p) => p.id);
      const [rows, prices] = await Promise.all([
        repo.planEntitlements(tx, ids),
        repo.activePrices(tx, ids),
      ]);
      const { seller } = this.settings.settings;
      const vat = vatFor(
        { country: seller.address.country, vatRateBp: seller.vatRateBp },
        { country: facts.country, vatNumber: facts.vatNumber },
      );
      const price = (planId: string, period: "month" | "year") => {
        const p = prices.find(
          (x) => x.planId === planId && x.currency === facts.currency && x.period === period,
        );
        return p
          ? {
              exclVatMinor: p.priceMinor,
              inclVatMinor: p.priceMinor + vatOf(p.priceMinor, vat.rateBp),
            }
          : null;
      };
      const offers: PlanOffer[] = plans.map((plan) => {
        const base = this.planBase(plan, rows);
        return {
          key: plan.key,
          name: plan.name,
          kind: plan.kind,
          prices: { month: price(plan.id, "month"), year: price(plan.id, "year") },
          features: base.features,
          limits: base.limits,
        };
      });
      return {
        currency: facts.currency,
        vatRateBp: vat.rateBp,
        vatNote: vat.note,
        paidPlansAvailable: this.paidPlansAvailable(facts.country),
        termsVersion: this.settings.termsVersion,
        termsUrl: this.settings.termsUrl,
        plans: offers,
      };
    });
  }

  private async clubFacts(
    tx: Tx,
    clubId: string,
  ): Promise<{ currency: string; country: string; vatNumber: string | null }> {
    const sub = await repo.findSubscription(tx, clubId);
    const account = await repo.findAccount(tx, clubId);
    const club = await this.clubs.getClubInTx(tx, clubId);
    return {
      currency: sub?.currency ?? club.currency,
      country: account?.address?.country ?? club.country,
      vatNumber: account?.vatNumber ?? null,
    };
  }

  // --- Subscription ---------------------------------------------------------------------

  /** The club's subscription (club managers, treasurers and operators; others see none). */
  getSubscription(context: TenantContext): Promise<Subscription | null> {
    return this.db.withTenant(context, (tx) => this.subscriptionInTx(tx, context.clubId));
  }

  private async subscriptionInTx(tx: Tx, clubId: string): Promise<Subscription | null> {
    const row = await repo.findSubscription(tx, clubId);
    if (!row) return null;
    const ids = [
      row.planId,
      ...row.addOnPlanIds,
      ...(row.scheduledPlanId ? [row.scheduledPlanId] : []),
      ...(row.scheduledAddOnPlanIds ?? []),
    ];
    const [plans, account, balance] = await Promise.all([
      repo.findPlansById(tx, ids),
      repo.findAccount(tx, clubId),
      repo.balanceDue(tx, clubId),
    ]);
    return this.toSubscription(row, plans, account, balance);
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
        const club = await this.clubs.getClubInTx(tx, context.clubId);
        const id = await repo.insertSubscription(tx, {
          clubId: context.clubId,
          planId: base.id,
          addOnPlanIds,
          status: "active",
          currentPeriodStart: new Date(),
          currency: club.currency,
        });
        await audit.record(tx, {
          action: "billing.subscription.created",
          resourceType: "subscription",
          resourceId: id,
        });
      }
      await outbox.publish(tx, "club.entitlements.changed", { clubId: context.clubId });
      const sub = await this.subscriptionInTx(tx, context.clubId);
      if (!sub) throw new DomainError("no_subscription");
      return sub;
    });
    await this.cache.invalidate(context.clubId);
    return result;
  }

  /**
   * Moves the subscription to another status (operators). The access state
   * follows; a restriction set here is the operator's. Cancelling needs the
   * open invoices paid or credited first (decision 13).
   */
  async changeStatus(context: TenantContext, status: SubscriptionStatus): Promise<Subscription> {
    const result = await this.db.withTenant(context, async (tx) => {
      const current = await repo.lockSubscription(tx, context.clubId);
      if (!current) throw new DomainError("no_subscription");
      if (current.status !== status) {
        if (!SUBSCRIPTION_TRANSITIONS[current.status].includes(status)) {
          throw new DomainError("subscription_transition_invalid");
        }
        if (status === "cancelled" && (await repo.balanceDue(tx, context.clubId)) > 0) {
          throw new DomainError("open_invoices");
        }
        await repo.updateSubscription(tx, context.clubId, {
          status,
          cancelledAt: status === "cancelled" ? new Date() : null,
          ...(status === "trial" ? { trialEndsAt: current.trialEndsAt ?? new Date() } : {}),
          ...(status === "active" ? { pastDueSince: null } : {}),
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
      const sub = await this.subscriptionInTx(tx, context.clubId);
      if (!sub) throw new DomainError("no_subscription");
      return sub;
    });
    await this.cache.invalidate(context.clubId);
    return result;
  }

  /** Extends or ends a trial (operators); a past end is applied by the worker at once. */
  async setTrial(context: TenantContext, trialEndsAt: Date): Promise<Subscription> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockSubscription(tx, context.clubId);
      if (!current) throw new DomainError("no_subscription");
      if (current.status !== "trial") throw new DomainError("subscription_transition_invalid");
      await repo.updateSubscription(tx, context.clubId, {
        trialEndsAt,
        // A longer trial reminds again.
        ...(current.trialEndsAt && trialEndsAt > current.trialEndsAt
          ? { trialReminderLevel: 0 }
          : {}),
      });
      await audit.record(tx, {
        action: "billing.subscription.trial.changed",
        resourceType: "subscription",
        resourceId: current.id,
        changedFields: ["trial_ends_at"],
      });
      if (trialEndsAt.getTime() <= Date.now()) {
        await outbox.publish(tx, "billing.subscription.changed", {
          clubId: context.clubId,
          change: "selected",
        });
      }
      return (await this.subscriptionInTx(tx, context.clubId))!;
    });
  }

  /**
   * A club manager's choice (MFA, checked by the policy): validated here,
   * written to the selection columns and applied by the worker. Upgrades
   * (a more expensive base plan, added add-ons, nothing removed, the same
   * billing period) and a paid period started during the trial take effect
   * at once; everything else at the trial's or the period's end.
   */
  async select(context: TenantContext, raw: SelectPlanInput): Promise<Subscription> {
    const input = SelectPlanSchema.parse(raw);
    return this.db.withTenant(context, async (tx) => {
      const clubId = context.clubId;
      const sub = await repo.lockSubscription(tx, clubId);
      if (!sub) throw new DomainError("no_subscription");
      if (sub.status !== "trial" && sub.status !== "active" && sub.status !== "past_due") {
        throw new DomainError("subscription_transition_invalid");
      }
      const plans = await repo.findPlansByKey(tx, [input.planKey, ...input.addOns]);
      const base = plans.find((p) => p.key === input.planKey && p.kind === "base" && p.active);
      const extras = [...new Set(input.addOns)].map((key) =>
        plans.find((p) => p.key === key && p.kind === "add_on" && p.active),
      );
      if (!base || extras.some((p) => !p)) throw new DomainError("plan_not_found");
      const addOnPlanIds = extras.map((p) => p!.id);
      const ids = [base.id, ...addOnPlanIds];
      const prices = await ledger.planPrices(tx, ids, sub.currency, input.billingPeriod);
      if (ids.some((id) => !prices.has(id))) throw new DomainError("price_not_available");
      const paid = [...prices.values()].some((p) => p > 0);
      const account = await repo.findAccount(tx, clubId);
      if (paid) {
        const club = await this.clubs.getClubInTx(tx, clubId);
        if (!this.paidPlansAvailable(account?.address?.country ?? club.country)) {
          throw new DomainError("paid_plan_unavailable");
        }
        if (!input.acceptTerms) throw new DomainError("terms_not_accepted");
        if (!ledger.accountComplete(account)) throw new DomainError("billing_details_incomplete");
        await repo.updateAccount(tx, clubId, {
          termsVersion: this.settings.termsVersion,
          termsAcceptedAt: new Date(),
        });
      }
      const now = new Date();
      const effectiveAt = await this.effectiveAt(tx, sub, {
        planId: base.id,
        addOnPlanIds,
        billingPeriod: input.billingPeriod,
        startNow: input.startNow,
        now,
      });
      await repo.updateSubscription(tx, clubId, {
        scheduledPlanId: base.id,
        scheduledAddOnPlanIds: addOnPlanIds,
        scheduledBillingPeriod: input.billingPeriod,
        scheduledEffectiveAt: effectiveAt,
        cancelAtPeriodEnd: false,
        selectedAt: now,
      });
      await audit.record(tx, {
        action: "billing.subscription.selected",
        resourceType: "subscription",
        resourceId: sub.id,
        changedFields: ["plan_id", "add_on_plan_ids", "billing_period", ...(paid ? ["terms"] : [])],
      });
      if (effectiveAt.getTime() <= now.getTime()) {
        await outbox.publish(tx, "billing.subscription.changed", { clubId, change: "selected" });
      }
      return (await this.subscriptionInTx(tx, clubId))!;
    });
  }

  /** When a selection takes effect (see select). */
  private async effectiveAt(
    tx: Tx,
    sub: repo.SubscriptionRow,
    next: {
      planId: string;
      addOnPlanIds: string[];
      billingPeriod: "month" | "year";
      startNow: boolean;
      now: Date;
    },
  ): Promise<Date> {
    if (sub.status === "trial") return next.startNow ? next.now : (sub.trialEndsAt ?? next.now);
    const end = sub.currentPeriodEnd;
    if (!end || end <= next.now) return next.now;
    const current = await ledger.planPrices(
      tx,
      [sub.planId, ...sub.addOnPlanIds],
      sub.currency,
      sub.billingPeriod,
    );
    // A free period ends at once: the paid period starts now.
    if (![...current.values()].some((p) => p > 0)) return next.now;
    if (next.billingPeriod !== sub.billingPeriod) return end;
    const target = await ledger.planPrices(tx, [next.planId], sub.currency, sub.billingPeriod);
    const upgrade =
      (target.get(next.planId) ?? 0) >= (current.get(sub.planId) ?? 0) &&
      sub.addOnPlanIds.every((id) => next.addOnPlanIds.includes(id));
    return upgrade ? next.now : end;
  }

  /** Cancels at the period end (club managers): the club then falls back to the default plan. */
  async cancel(context: TenantContext): Promise<Subscription> {
    return this.db.withTenant(context, async (tx) => {
      const sub = await repo.lockSubscription(tx, context.clubId);
      if (!sub) throw new DomainError("no_subscription");
      if (sub.status === "trial" || sub.status === "cancelled") {
        throw new DomainError("subscription_transition_invalid");
      }
      await repo.updateSubscription(tx, context.clubId, {
        cancelAtPeriodEnd: true,
        scheduledPlanId: null,
        scheduledAddOnPlanIds: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
      });
      await audit.record(tx, {
        action: "billing.subscription.cancelled",
        resourceType: "subscription",
        resourceId: sub.id,
        changedFields: ["cancel_at_period_end"],
      });
      return (await this.subscriptionInTx(tx, context.clubId))!;
    });
  }

  /** Undoes a pending cancellation or a scheduled change (club managers). */
  async resume(context: TenantContext): Promise<Subscription> {
    return this.db.withTenant(context, async (tx) => {
      const sub = await repo.lockSubscription(tx, context.clubId);
      if (!sub) throw new DomainError("no_subscription");
      await repo.updateSubscription(tx, context.clubId, {
        cancelAtPeriodEnd: false,
        scheduledPlanId: null,
        scheduledAddOnPlanIds: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
      });
      await audit.record(tx, {
        action: "billing.subscription.resumed",
        resourceType: "subscription",
        resourceId: sub.id,
        changedFields: ["cancel_at_period_end", "scheduled_plan_id"],
      });
      return (await this.subscriptionInTx(tx, context.clubId))!;
    });
  }

  // --- Billing details --------------------------------------------------------------------

  getAccount(context: TenantContext): Promise<BillingAccount | null> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findAccount(tx, context.clubId);
      return row ? this.toAccount(row) : null;
    });
  }

  /** The billing details (club managers and treasurers, MFA); the org number by the country pack. */
  async putAccount(context: TenantContext, raw: BillingAccountInput): Promise<BillingAccount> {
    const input = BillingAccountInputSchema.parse(raw);
    const country = input.address.country.toUpperCase();
    let organizationNumber = input.organizationNumber ?? null;
    if (organizationNumber && isSupportedCountry(country)) {
      organizationNumber = getCountryPack(country).normalizeOrganizationNumber(organizationNumber);
      if (!organizationNumber) throw new DomainError("invalid_organization_number");
    }
    return this.db.withTenant(context, async (tx) => {
      const before = await repo.findAccount(tx, context.clubId);
      const values = {
        legalName: input.legalName,
        organizationNumber,
        vatNumber: input.vatNumber ?? null,
        address: { ...input.address, country },
        invoiceEmail: input.invoiceEmail,
        reference: input.reference ?? null,
        invoiceLocale: input.invoiceLocale,
      };
      await repo.upsertAccount(tx, context.clubId, values);
      const changed = before
        ? Object.entries(values)
            .filter(
              ([k, v]) =>
                JSON.stringify(v) !== JSON.stringify(before[k as keyof repo.AccountRow] ?? null),
            )
            .map(([k]) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
        : Object.keys(values).map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
      if (changed.length > 0) {
        await audit.record(tx, {
          action: "billing.account.updated",
          resourceType: "billing_account",
          resourceId: context.clubId,
          changedFields: changed,
        });
      }
      return this.toAccount((await repo.findAccount(tx, context.clubId))!);
    });
  }

  /** Invoice (PR A); card needs the provider's hosted setup (PR B). */
  async setPaymentMethod(
    context: TenantContext,
    method: "invoice" | "card",
  ): Promise<{ method: "invoice" | "card"; redirectUrl: string | null }> {
    if (method === "card") throw new DomainError("payment_method_unavailable");
    await this.db.withTenant(context, async (tx) => {
      const account = await repo.findAccount(tx, context.clubId);
      if (!account) throw new DomainError("billing_details_incomplete");
      if (account.paymentMethod === method) return;
      await repo.updateAccount(tx, context.clubId, { paymentMethod: method });
      await audit.record(tx, {
        action: "billing.account.updated",
        resourceType: "billing_account",
        resourceId: context.clubId,
        changedFields: ["payment_method"],
      });
    });
    return { method, redirectUrl: null };
  }

  // --- Invoices -------------------------------------------------------------------------

  listInvoices(context: TenantContext, cursor: string | null): Promise<InvoicePage> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.listInvoices(tx, context.clubId, cursor, PAGE_SIZE + 1);
      const page = rows.slice(0, PAGE_SIZE);
      const items = await this.summaries(tx, page, null);
      return { items, nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.id : null };
    });
  }

  /** Summaries with balances: payments and credit notes of the page in two queries. */
  private async summaries(
    tx: Tx,
    rows: readonly repo.InvoiceRow[],
    clubs: Map<string, repo.ClubRef> | null,
  ): Promise<InvoiceSummary[]> {
    const ids = rows.filter((r) => r.kind === "invoice").map((r) => r.id);
    const [payments, credits] = await Promise.all([
      repo.invoicePayments(tx, ids),
      repo.creditNotesOf(tx, ids),
    ]);
    return rows.map((r) => {
      const paid = payments
        .filter((p) => p.invoiceId === r.id && p.status === "succeeded")
        .reduce((s, p) => s + p.amountMinor, 0);
      const credited = credits
        .filter((c) => c.creditedInvoiceId === r.id)
        .reduce((s, c) => s + c.totalMinor, 0);
      const ref = clubs?.get(r.clubId);
      const club = ref ? { id: ref.id, name: ref.name, country: ref.country } : undefined;
      return {
        id: r.id,
        number: r.number,
        kind: r.kind,
        status: r.status,
        currency: r.currency,
        subtotalMinor: r.subtotalMinor,
        vatMinor: r.vatMinor,
        totalMinor: r.totalMinor,
        balanceMinor:
          r.kind === "invoice" && r.status === "open" ? r.totalMinor - paid + credited : 0,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        issuedAt: iso(r.issuedAt),
        dueAt: iso(r.dueAt),
        paidAt: iso(r.paidAt),
        paymentMethod: (r.paymentMethod as "invoice" | "card" | null) ?? null,
        hasPdf: r.pdfObjectKey !== null,
        ...(club ? { club } : {}),
      };
    });
  }

  /** One invoice with lines, VAT summary, payments and payment instructions. */
  getInvoice(context: TenantContext, invoiceId: string): Promise<InvoiceDetail> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findInvoice(tx, invoiceId);
      if (!row || row.clubId !== context.clubId || row.status === "draft") {
        throw new DomainError("invoice_not_found");
      }
      const [summary] = await this.summaries(tx, [row], null);
      const lines = await repo.invoiceLines(tx, invoiceId);
      const plans = await repo.findPlansById(
        tx,
        lines.flatMap((l) => (l.planId ? [l.planId] : [])),
      );
      const payments = await repo.invoicePayments(tx, [invoiceId]);
      const byRate = new Map<number, { baseMinor: number; vatMinor: number }>();
      for (const l of lines) {
        const r = byRate.get(l.vatRateBp) ?? { baseMinor: 0, vatMinor: 0 };
        r.baseMinor += l.amountMinor;
        r.vatMinor += l.vatMinor;
        byRate.set(l.vatRateBp, r);
      }
      const seller = row.seller as { bankgiro?: string } | null;
      const buyer = row.buyer as { vatNote?: "none" | "reverse_charge" | "outside_scope" } | null;
      return {
        ...summary!,
        lines: lines.map((l) => {
          const plan = plans.find((p) => p.id === l.planId);
          return {
            descriptionKey: l.descriptionKey,
            planKey: plan?.key ?? null,
            planName: plan?.name ?? null,
            quantity: l.quantity,
            unitMinor: l.unitMinor,
            amountMinor: l.amountMinor,
            periodStart: iso(l.periodStart),
            periodEnd: iso(l.periodEnd),
            proration: l.proration,
            vatRateBp: l.vatRateBp,
            vatMinor: l.vatMinor,
          };
        }),
        vatSummary: [...byRate.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([rateBp, r]) => ({ rateBp, ...r })),
        vatNote: buyer?.vatNote ?? "none",
        payments: payments.map((p) => this.toPayment(p)),
        instructions:
          row.kind === "invoice" && row.status === "open" && row.ocrReference && seller?.bankgiro
            ? {
                bankgiro: seller.bankgiro,
                ocrReference: row.ocrReference,
                amountMinor: summary!.balanceMinor,
              }
            : null,
        creditedInvoiceId: row.creditedInvoiceId,
        creditReason: (row.creditReason as InvoiceDetail["creditReason"]) ?? null,
      };
    });
  }

  /** A pre-signed download of the PDF, valid five minutes. */
  invoicePdf(
    context: TenantContext,
    invoiceId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findInvoice(tx, invoiceId);
      if (!row || row.clubId !== context.clubId || row.status === "draft") {
        throw new DomainError("invoice_not_found");
      }
      const storage = this.settings.storage;
      if (!row.pdfObjectKey || !storage) throw new DomainError("pdf_unavailable");
      return {
        url: storage.presignDownload(row.pdfObjectKey, {
          expiresSeconds: PDF_SECONDS,
          filename: `${row.number ?? row.id}.pdf`,
        }),
        expiresAt: new Date(Date.now() + PDF_SECONDS * 1000).toISOString(),
      };
    });
  }

  // --- Operators: lists, payments, credit notes -------------------------------------------

  listSubscriptions(
    context: ActorContext,
    query: { status?: string | undefined; plan?: string | undefined; cursor?: string | undefined },
  ) {
    return this.db.withActor(context, async (tx) => {
      const planId = query.plan ? (await repo.findPlansByKey(tx, [query.plan]))[0]?.id : undefined;
      if (query.plan && !planId) return { items: [], nextCursor: null };
      const rows = await repo.operatorSubscriptions(
        tx,
        { status: query.status, planId },
        query.cursor ?? null,
        PAGE_SIZE + 1,
      );
      const page = rows.slice(0, PAGE_SIZE);
      const plans = await repo.findPlansById(tx, [
        ...new Set(page.flatMap((r) => [r.subscription.planId, ...r.subscription.addOnPlanIds])),
      ]);
      const key = (id: string) => plans.find((p) => p.id === id)?.key ?? id;
      return {
        items: page.map((r) => ({
          club: { id: r.clubId, name: r.clubName, country: r.country },
          subscriptionId: r.subscription.id,
          planKey: key(r.subscription.planId),
          addOns: r.subscription.addOnPlanIds.map(key),
          status: r.subscription.status,
          billingPeriod: r.subscription.billingPeriod,
          trialEndsAt: iso(r.subscription.trialEndsAt),
          currentPeriodEnd: iso(r.subscription.currentPeriodEnd),
          pastDueSince: iso(r.subscription.pastDueSince),
          paymentMethod: r.paymentMethod,
          balanceDueMinor: r.balanceDueMinor,
          accessState: r.accessState,
        })),
        nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.subscription.id : null,
      };
    });
  }

  /** Issued invoices of all clubs (operators); `limit` is larger for CSV exports. */
  listAllInvoices(
    context: ActorContext,
    query: {
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
    },
    limit = PAGE_SIZE,
  ): Promise<InvoicePage> {
    return this.db.withActor(context, async (tx) => {
      const rows = await repo.operatorInvoices(tx, query, query.cursor ?? null, limit + 1);
      const page = rows.slice(0, limit);
      const clubs = await repo.clubRefs(
        tx,
        page.map((r) => r.clubId),
      );
      return {
        items: await this.summaries(tx, page, clubs),
        nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      };
    });
  }

  listPayments(
    context: ActorContext,
    query: { from?: string | undefined; to?: string | undefined; cursor?: string | undefined },
    limit = PAGE_SIZE,
  ) {
    return this.db.withActor(context, async (tx) => {
      const rows = await repo.operatorPayments(tx, query, query.cursor ?? null, limit + 1);
      const page = rows.slice(0, limit);
      const clubs = await repo.clubRefs(
        tx,
        page.map((r) => r.clubId),
      );
      return {
        items: page.map((p) => ({
          ...this.toPayment(p),
          invoiceId: p.invoiceId,
          invoiceNumber: p.invoiceNumber,
          club: { id: p.clubId, name: clubs.get(p.clubId)?.name ?? "" },
        })),
        nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      };
    });
  }

  /** The club of an invoice (operators: the tenant to work in). */
  private invoiceClub(context: ActorContext, invoiceId: string): Promise<string> {
    return this.db.withActor(context, async (tx) => {
      const row = await repo.findInvoice(tx, invoiceId);
      if (!row || row.status === "draft") throw new DomainError("invoice_not_found");
      return row.clubId;
    });
  }

  /** Records a bank payment against an invoice (operators); idempotent by reference. */
  async recordPayment(
    context: ActorContext,
    invoiceId: string,
    input: RecordPaymentInput,
  ): Promise<InvoiceDetail> {
    const clubId = await this.invoiceClub(context, invoiceId);
    const tenant: TenantContext = { ...context, clubId };
    await this.db.withTenant(tenant, (tx) =>
      ledgerCall(() =>
        ledger.recordPayment(tx, {
          invoiceId,
          provider: "manual",
          reference: input.reference,
          amountMinor: input.amountMinor,
          receivedOn: input.receivedOn,
          status: "succeeded",
          now: new Date(),
        }),
      ),
    );
    await this.cache.invalidate(clubId);
    return this.getInvoice(tenant, invoiceId);
  }

  /** Issues a credit note for an invoice, all or some lines (operators). */
  async creditNote(
    context: ActorContext,
    invoiceId: string,
    input: CreditNoteInput,
  ): Promise<InvoiceDetail> {
    const clubId = await this.invoiceClub(context, invoiceId);
    const tenant: TenantContext = { ...context, clubId };
    const issued = await this.db.withTenant(tenant, (tx) =>
      ledgerCall(() =>
        ledger.issueCreditNote(tx, this.settings.settings, {
          invoiceId,
          lines: input.lines,
          reason: input.reason,
          now: new Date(),
        }),
      ),
    );
    await this.cache.invalidate(clubId);
    return this.getInvoice(tenant, issued.invoiceId);
  }

  /** Emails the invoice again (operators). */
  async resend(context: ActorContext, invoiceId: string): Promise<void> {
    const clubId = await this.invoiceClub(context, invoiceId);
    await this.db.withTenant({ ...context, clubId }, async (tx) => {
      await outbox.publish(tx, "billing.invoice.resend_requested", { clubId, invoiceId });
      await audit.record(tx, {
        action: "billing.invoice.resent",
        resourceType: "invoice",
        resourceId: invoiceId,
      });
    });
  }

  // --- Mapping --------------------------------------------------------------------------

  private toPayment(p: repo.PaymentRow) {
    return {
      id: p.id,
      provider: p.provider,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      receivedOn: p.receivedOn,
      recordedAt: p.recordedAt.toISOString(),
    };
  }

  private toAccount(row: repo.AccountRow): BillingAccount {
    const a = row.address;
    return {
      legalName: row.legalName,
      organizationNumber: row.organizationNumber,
      vatNumber: row.vatNumber,
      address:
        a?.street && a.postalCode && a.city && a.country
          ? { street: a.street, postalCode: a.postalCode, city: a.city, country: a.country }
          : null,
      invoiceEmail: row.invoiceEmail,
      reference: row.reference,
      invoiceLocale: row.invoiceLocale,
      paymentMethod: row.paymentMethod,
      cardBrand: row.cardBrand,
      cardLast4: row.cardLast4,
      termsVersion: row.termsVersion,
      termsAcceptedAt: iso(row.termsAcceptedAt),
      complete: ledger.accountComplete(row),
    };
  }

  private toSubscription(
    row: repo.SubscriptionRow,
    plans: readonly repo.PlanRow[],
    account: repo.AccountRow | null,
    balanceDueMinor: number,
  ): Subscription {
    const key = (id: string) => plans.find((p) => p.id === id)?.key ?? id;
    const scheduled =
      row.scheduledEffectiveAt !== null
        ? {
            planKey: row.scheduledPlanId ? key(row.scheduledPlanId) : null,
            addOns: row.scheduledAddOnPlanIds?.map(key) ?? null,
            billingPeriod: row.scheduledBillingPeriod,
            at: iso(row.scheduledEffectiveAt),
          }
        : null;
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
      billingPeriod: row.billingPeriod,
      currency: row.currency,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      scheduledChange: scheduled,
      pastDueSince: iso(row.pastDueSince),
      paymentMethod: account
        ? {
            method: account.paymentMethod,
            cardBrand: account.cardBrand,
            cardLast4: account.cardLast4,
          }
        : null,
      balanceDueMinor,
      selectedAt: iso(row.selectedAt),
    };
  }
}
