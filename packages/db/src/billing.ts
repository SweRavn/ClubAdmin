// SPDX-License-Identifier: AGPL-3.0-only
// The billing ledger (P1.13, ADR 0045): issuing invoices and credit notes,
// recording payments, applying a club's plan selection, ending trials,
// renewing periods and dunning. Shared by the API (operators: payments,
// credit notes) and the worker (billing:daily, the selection handler). Every
// function runs in the caller's transaction, in the club's tenant, as a
// system job or an operator: club managers only write the selection columns
// of their subscription (the guard trigger), never invoices.
//
// Money is integer minor units; VAT per line from vatFor(seller, buyer);
// periods are calendar months or years in the club's time zone. Invoices are
// issued once per subscription and period (unique index), numbered from one
// gapless series under its row lock, and immutable once issued.

import {
  type BillingPeriod,
  daysBetween,
  type DraftLine,
  ocrReference,
  periodAt,
  priceLines,
  prorate,
  uuidv7,
  vatFor,
  type VatNote,
} from "@clubadmin/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { audit } from "./audit.ts";
import type { Tx } from "./database.ts";
import {
  billingAccounts,
  billingInvoiceLines,
  billingInvoices,
  billingPayments,
  billingPlanPrices,
  billingPlans,
  billingSubscriptions,
} from "./infra/tables.ts";
import { outbox } from "./outbox.ts";

/** The invoicing entity, printed on every invoice (BILLING_SELLER_*). */
export interface SellerSnapshot {
  name: string;
  organizationNumber: string;
  vatNumber: string | null;
  address: { street: string; postalCode: string; city: string; country: string };
  email: string | null;
  bankgiro: string;
  fTax: boolean;
  vatRateBp: number;
}

/** The club as a buyer at the time of issue. */
export interface BuyerSnapshot {
  legalName: string;
  organizationNumber: string | null;
  vatNumber: string | null;
  address: { street?: string; postalCode?: string; city?: string; country?: string } | null;
  reference: string | null;
  country: string;
  locale: "sv" | "en" | "nb";
  vatNote: VatNote;
}

export interface LedgerSettings {
  seller: SellerSnapshot;
  invoicePrefix: string;
  paymentTermsDays: number;
  /** BILLING_DEFAULT_PLAN: where trials without a choice and cancellations end up. */
  defaultPlan: string;
}

/** Dunning (decision 8): reminders on days 1 and 14 overdue, read-only on day 30. */
export const DUNNING_DAYS = { pastDue: 1, secondReminder: 14, readOnly: 30 } as const;
/** Trial reminders: 7 days and 1 day before the end. */
export const TRIAL_REMINDER_DAYS = [7, 1] as const;

const DAY_MS = 86_400_000;
type Subscription = typeof billingSubscriptions.$inferSelect;
type Invoice = typeof billingInvoices.$inferSelect;

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "LedgerError";
    this.code = code;
  }
}

interface ClubFacts {
  name: string;
  timeZone: string;
  country: string;
  accessState: string;
  accessStateSource: string | null;
}

async function clubFacts(tx: Tx, clubId: string): Promise<ClubFacts> {
  const { rows } = await tx.execute<{
    name: string;
    time_zone: string;
    country: string;
    access_state: string;
    access_state_source: string | null;
  }>(sql`
    SELECT name, time_zone, country, access_state, access_state_source
    FROM public.clubs WHERE id = ${clubId}`);
  const row = rows[0];
  if (!row) throw new LedgerError("club_not_found");
  return {
    name: row.name,
    timeZone: row.time_zone,
    country: row.country,
    accessState: row.access_state,
    accessStateSource: row.access_state_source,
  };
}

/** The buyer details are complete enough to invoice. */
export function accountComplete(
  account: Pick<
    typeof billingAccounts.$inferSelect,
    "legalName" | "address" | "invoiceEmail"
  > | null,
): boolean {
  const a = account?.address;
  return Boolean(
    account?.legalName && account.invoiceEmail && a?.street && a.postalCode && a.city && a.country,
  );
}

async function buyerOf(tx: Tx, clubId: string, seller: SellerSnapshot): Promise<BuyerSnapshot> {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.clubId, clubId));
  const club = await clubFacts(tx, clubId);
  const country = account?.address?.country ?? club.country;
  const vat = vatFor(
    { country: seller.address.country, vatRateBp: seller.vatRateBp },
    { country, vatNumber: account?.vatNumber ?? null },
  );
  return {
    legalName: account?.legalName ?? club.name,
    organizationNumber: account?.organizationNumber ?? null,
    vatNumber: account?.vatNumber ?? null,
    address: account?.address ?? null,
    reference: account?.reference ?? null,
    country,
    locale: account?.invoiceLocale ?? "sv",
    vatNote: vat.note,
  };
}

const vatRate = (seller: SellerSnapshot, buyer: BuyerSnapshot) =>
  vatFor({ country: seller.address.country, vatRateBp: seller.vatRateBp }, buyer).rateBp;

/** Active prices of plans in a currency and period. */
export async function planPrices(
  tx: Tx,
  planIds: readonly string[],
  currency: string,
  period: BillingPeriod,
): Promise<Map<string, number>> {
  if (planIds.length === 0) return new Map();
  const rows = await tx
    .select({ planId: billingPlanPrices.planId, priceMinor: billingPlanPrices.priceMinor })
    .from(billingPlanPrices)
    .where(
      and(
        inArray(billingPlanPrices.planId, [...planIds]),
        eq(billingPlanPrices.currency, currency),
        eq(billingPlanPrices.period, period),
        eq(billingPlanPrices.active, true),
      ),
    );
  return new Map(rows.map((r) => [r.planId, r.priceMinor]));
}

const plansOf = (planId: string, addOns: readonly string[]) => [planId, ...addOns];

/** The recurring lines of a set of plans for a period, prorated from `from`. */
async function recurringLines(
  tx: Tx,
  input: {
    planIds: readonly string[];
    currency: string;
    billingPeriod: BillingPeriod;
    period: { start: Date; end: Date };
    from: Date;
    timeZone: string;
  },
): Promise<Omit<DraftLine, "vatRateBp">[]> {
  const prices = await planPrices(tx, input.planIds, input.currency, input.billingPeriod);
  const prorated = input.from.getTime() > input.period.start.getTime();
  return input.planIds.flatMap((planId) => {
    const price = prices.get(planId) ?? 0;
    const amount = prorated ? prorate(price, input.period, input.from, input.timeZone) : price;
    if (amount === 0) return [];
    return [
      {
        descriptionKey: `plan.${input.billingPeriod}`,
        planId,
        quantity: 1,
        unitMinor: amount,
        amountMinor: amount,
        periodStart: prorated ? input.from : input.period.start,
        periodEnd: input.period.end,
        proration: prorated,
      },
    ];
  });
}

/** The draft of the next period's invoice (prorated upgrades wait there). */
async function draftFor(
  tx: Tx,
  subscriptionId: string,
  periodStart: Date,
): Promise<Invoice | null> {
  const [row] = await tx
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.subscriptionId, subscriptionId),
        eq(billingInvoices.periodStart, periodStart),
        eq(billingInvoices.kind, "invoice"),
        sql`${billingInvoices.status} <> 'void'`,
      ),
    )
    .for("update");
  return row ?? null;
}

async function insertLines(
  tx: Tx,
  clubId: string,
  invoiceId: string,
  lines: readonly Omit<DraftLine, "vatRateBp">[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(billingInvoiceLines).values(
    lines.map((l) => ({
      id: uuidv7(),
      clubId,
      invoiceId,
      descriptionKey: l.descriptionKey,
      quantity: l.quantity,
      unitMinor: l.unitMinor,
      amountMinor: l.amountMinor,
      planId: l.planId,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      proration: l.proration,
    })),
  );
}

/** Adds lines to the draft invoice of a period (created when missing). */
async function addToDraft(
  tx: Tx,
  sub: Subscription,
  period: { start: Date; end: Date },
  lines: readonly Omit<DraftLine, "vatRateBp">[],
): Promise<void> {
  if (lines.length === 0) return;
  let draft = await draftFor(tx, sub.id, period.start);
  if (draft && draft.status !== "draft") return; // already issued: nothing to add
  if (!draft) {
    const id = uuidv7();
    await tx.insert(billingInvoices).values({
      id,
      clubId: sub.clubId,
      subscriptionId: sub.id,
      currency: sub.currency,
      periodStart: period.start,
      periodEnd: period.end,
    });
    draft = (await draftFor(tx, sub.id, period.start))!;
  }
  await insertLines(tx, sub.clubId, draft.id, lines);
}

export interface Issued {
  invoiceId: string;
  number: string;
  totalMinor: number;
}

/**
 * Issues the invoice of a subscription's period: its draft lines (prorated
 * upgrades) and the given recurring lines, VAT per the buyer, the next
 * number, the OCR reference and the due date. Nothing when the period is
 * already invoiced or there is nothing to charge.
 */
export async function issueInvoice(
  tx: Tx,
  settings: LedgerSettings,
  input: {
    sub: Subscription;
    period: { start: Date; end: Date };
    lines: readonly Omit<DraftLine, "vatRateBp">[];
    now: Date;
  },
): Promise<Issued | null> {
  const { sub, period, now } = input;
  const existing = await draftFor(tx, sub.id, period.start);
  if (existing && existing.status !== "draft") return null;
  const draftLines = existing
    ? await tx
        .select()
        .from(billingInvoiceLines)
        .where(eq(billingInvoiceLines.invoiceId, existing.id))
        .orderBy(asc(billingInvoiceLines.id))
    : [];
  const all = [
    ...input.lines,
    ...draftLines.map((l) => ({
      descriptionKey: l.descriptionKey,
      planId: l.planId,
      quantity: l.quantity,
      unitMinor: l.unitMinor,
      amountMinor: l.amountMinor,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      proration: l.proration,
    })),
  ];
  if (all.length === 0) return null;
  const buyer = await buyerOf(tx, sub.clubId, settings.seller);
  const rate = vatRate(settings.seller, buyer);
  const totals = priceLines(all.map((l) => ({ ...l, vatRateBp: rate })));
  if (totals.totalMinor <= 0 && !existing) return null;
  const [account] = await tx
    .select({ paymentMethod: billingAccounts.paymentMethod })
    .from(billingAccounts)
    .where(eq(billingAccounts.clubId, sub.clubId));

  const id = existing?.id ?? uuidv7();
  if (!existing) {
    await tx.insert(billingInvoices).values({
      id,
      clubId: sub.clubId,
      subscriptionId: sub.id,
      currency: sub.currency,
      periodStart: period.start,
      periodEnd: period.end,
    });
  }
  // The new lines, then VAT on every line of the draft (in order of creation).
  await insertLines(tx, sub.clubId, id, input.lines);
  const stored = await tx
    .select()
    .from(billingInvoiceLines)
    .where(eq(billingInvoiceLines.invoiceId, id))
    .orderBy(asc(billingInvoiceLines.id));
  for (const line of stored) {
    const priced = priceLines([{ ...line, vatRateBp: rate }]).lines[0]!;
    await tx
      .update(billingInvoiceLines)
      .set({ vatRateBp: rate, vatMinor: priced.vatMinor })
      .where(eq(billingInvoiceLines.id, line.id));
  }
  const number = await nextNumber(tx, settings.invoicePrefix);
  await tx
    .update(billingInvoices)
    .set({
      number,
      status: "open",
      subtotalMinor: totals.subtotalMinor,
      vatMinor: totals.vatMinor,
      totalMinor: totals.totalMinor,
      issuedAt: now,
      dueAt: new Date(now.getTime() + settings.paymentTermsDays * DAY_MS),
      seller: { ...settings.seller },
      buyer: { ...buyer },
      paymentMethod: account?.paymentMethod ?? "invoice",
      ocrReference: ocrReference(number),
    })
    .where(eq(billingInvoices.id, id));
  await audit.record(tx, {
    action: "billing.invoice.issued",
    resourceType: "invoice",
    resourceId: id,
  });
  await outbox.publish(tx, "billing.invoice.issued", { clubId: sub.clubId, invoiceId: id });
  return { invoiceId: id, number, totalMinor: totals.totalMinor };
}

async function nextNumber(tx: Tx, prefix: string): Promise<string> {
  const { rows } = await tx.execute<{ number: string }>(
    sql`SELECT billing.next_invoice_number('default', ${prefix}) AS number`,
  );
  return rows[0]!.number;
}

/** What is left to pay: total, minus succeeded payments, minus credit notes. */
export async function balanceOf(tx: Tx, invoice: Invoice): Promise<number> {
  const { rows } = await tx.execute<{ paid: string | null; credited: string | null }>(sql`
    SELECT
      (SELECT sum(amount_minor) FROM billing.payments
       WHERE invoice_id = ${invoice.id} AND status = 'succeeded') AS paid,
      (SELECT sum(total_minor) FROM billing.invoices
       WHERE credited_invoice_id = ${invoice.id} AND status <> 'void') AS credited`);
  const paid = Number(rows[0]?.paid ?? 0);
  const credited = Number(rows[0]?.credited ?? 0); // negative totals
  return invoice.totalMinor - paid + credited;
}

async function lockInvoice(tx: Tx, invoiceId: string): Promise<Invoice> {
  const [invoice] = await tx
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.id, invoiceId))
    .for("update");
  if (!invoice) throw new LedgerError("invoice_not_found");
  return invoice;
}

/** Marks a settled invoice paid and restores the club when nothing is overdue any more. */
async function settleIfPaid(tx: Tx, invoice: Invoice, now: Date): Promise<boolean> {
  if (invoice.status !== "open" || (await balanceOf(tx, invoice)) > 0) return false;
  await tx
    .update(billingInvoices)
    .set({ status: "paid", paidAt: now })
    .where(eq(billingInvoices.id, invoice.id));
  await outbox.publish(tx, "billing.invoice.paid", {
    clubId: invoice.clubId,
    invoiceId: invoice.id,
  });
  await restoreIfSettled(tx, invoice.clubId, now);
  return true;
}

/**
 * Records a payment against an open invoice (a bank payment by an operator;
 * card payments in PR B). Idempotent by the provider's reference.
 */
export async function recordPayment(
  tx: Tx,
  input: {
    invoiceId: string;
    provider: string;
    reference: string;
    amountMinor: number;
    receivedOn: string | null;
    status: "succeeded" | "failed" | "pending";
    failureCode?: string | null;
    now: Date;
  },
): Promise<{ paymentId: string; duplicate: boolean; paid: boolean }> {
  const invoice = await lockInvoice(tx, input.invoiceId);
  const [existing] = await tx
    .select({ id: billingPayments.id, invoiceId: billingPayments.invoiceId })
    .from(billingPayments)
    .where(
      and(
        eq(billingPayments.provider, input.provider),
        eq(billingPayments.providerReference, input.reference),
      ),
    );
  if (existing) {
    if (existing.invoiceId !== invoice.id) throw new LedgerError("payment_reference_used");
    return { paymentId: existing.id, duplicate: true, paid: invoice.status === "paid" };
  }
  if (invoice.kind !== "invoice" || invoice.status !== "open") {
    throw new LedgerError("invoice_not_open");
  }
  if (input.status === "succeeded" && input.amountMinor > (await balanceOf(tx, invoice))) {
    throw new LedgerError("payment_exceeds_balance");
  }
  const id = uuidv7();
  await tx.insert(billingPayments).values({
    id,
    clubId: invoice.clubId,
    invoiceId: invoice.id,
    provider: input.provider,
    providerReference: input.reference,
    amountMinor: input.amountMinor,
    currency: invoice.currency,
    status: input.status,
    failureCode: input.failureCode ?? null,
    receivedOn: input.receivedOn,
    recordedAt: input.now,
  });
  await audit.record(tx, {
    action: input.status === "failed" ? "billing.payment.failed" : "billing.payment.recorded",
    resourceType: "payment",
    resourceId: id,
  });
  const paid = input.status === "succeeded" && (await settleIfPaid(tx, invoice, input.now));
  return { paymentId: id, duplicate: false, paid };
}

/**
 * Issues a credit note for an issued invoice: all its lines or the chosen
 * ones, negated, with the invoice's VAT, the next number of the same series
 * and a reason code. Settles the invoice when nothing is left to pay.
 */
export async function issueCreditNote(
  tx: Tx,
  settings: LedgerSettings,
  input: { invoiceId: string; lines?: readonly number[] | undefined; reason: string; now: Date },
): Promise<Issued> {
  const invoice = await lockInvoice(tx, input.invoiceId);
  if (invoice.kind !== "invoice" || invoice.status === "draft" || invoice.status === "void") {
    throw new LedgerError("invoice_not_open");
  }
  const lines = await tx
    .select()
    .from(billingInvoiceLines)
    .where(eq(billingInvoiceLines.invoiceId, invoice.id))
    .orderBy(asc(billingInvoiceLines.id));
  const chosen = input.lines ? lines.filter((_, i) => input.lines!.includes(i)) : lines;
  if (chosen.length === 0 || (input.lines && chosen.length !== new Set(input.lines).size)) {
    throw new LedgerError("credit_lines_invalid");
  }
  // Never more than what is not credited yet.
  const { rows } = await tx.execute<{ credited: string | null }>(sql`
    SELECT sum(total_minor) AS credited FROM billing.invoices
    WHERE credited_invoice_id = ${invoice.id} AND status <> 'void'`);
  const credited = -Number(rows[0]?.credited ?? 0);
  const totals = priceLines(
    chosen.map((l) => ({
      descriptionKey: l.descriptionKey,
      planId: l.planId,
      quantity: l.quantity,
      unitMinor: -l.unitMinor,
      amountMinor: -l.amountMinor,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      proration: l.proration,
      vatRateBp: l.vatRateBp,
    })),
  );
  if (credited - totals.totalMinor > invoice.totalMinor) {
    throw new LedgerError("credit_exceeds_invoice");
  }
  const id = uuidv7();
  const number = await nextNumber(tx, settings.invoicePrefix);
  await tx.insert(billingInvoices).values({
    id,
    clubId: invoice.clubId,
    subscriptionId: invoice.subscriptionId,
    currency: invoice.currency,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    kind: "credit_note",
    creditedInvoiceId: invoice.id,
    creditReason: input.reason,
  });
  await tx.insert(billingInvoiceLines).values(
    totals.lines.map((l) => ({
      id: uuidv7(),
      clubId: invoice.clubId,
      invoiceId: id,
      descriptionKey: l.descriptionKey,
      quantity: l.quantity,
      unitMinor: l.unitMinor,
      amountMinor: l.amountMinor,
      planId: l.planId,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      proration: l.proration,
      vatRateBp: l.vatRateBp,
      vatMinor: l.vatMinor,
    })),
  );
  // The credit note is settled when issued (status paid); its legal content
  // repeats the seller and buyer of the invoice it corrects.
  await tx
    .update(billingInvoices)
    .set({
      number,
      status: "paid",
      subtotalMinor: totals.subtotalMinor,
      vatMinor: totals.vatMinor,
      totalMinor: totals.totalMinor,
      issuedAt: input.now,
      paidAt: input.now,
      seller: invoice.seller,
      buyer: invoice.buyer,
      paymentMethod: invoice.paymentMethod,
    })
    .where(eq(billingInvoices.id, id));
  await audit.record(tx, {
    action: "billing.credit_note.issued",
    resourceType: "invoice",
    resourceId: id,
  });
  await outbox.publish(tx, "billing.invoice.issued", { clubId: invoice.clubId, invoiceId: id });
  await settleIfPaid(tx, invoice, input.now);
  return { invoiceId: id, number, totalMinor: totals.totalMinor };
}

// --- Subscription lifecycle -------------------------------------------------------------

async function lockSubscription(tx: Tx, clubId: string): Promise<Subscription | null> {
  const [row] = await tx
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.clubId, clubId))
    .for("update");
  return row ?? null;
}

async function update(
  tx: Tx,
  sub: Subscription,
  values: Partial<Subscription>,
): Promise<Subscription> {
  const [row] = await tx
    .update(billingSubscriptions)
    .set(values)
    .where(eq(billingSubscriptions.id, sub.id))
    .returning();
  return row!;
}

async function defaultPlanId(tx: Tx, key: string): Promise<string> {
  const [plan] = await tx
    .select({ id: billingPlans.id })
    .from(billingPlans)
    .where(and(eq(billingPlans.key, key), eq(billingPlans.kind, "base")));
  if (!plan) throw new LedgerError("plan_not_found");
  return plan.id;
}

/** The club's access state from billing (never lifting an operator's restriction). */
async function setAccess(
  tx: Tx,
  clubId: string,
  club: ClubFacts,
  state: "active" | "read_only",
): Promise<boolean> {
  if (state === "read_only" && club.accessState !== "active") return false;
  if (
    state === "active" &&
    (club.accessState === "active" || club.accessStateSource !== "billing")
  ) {
    return false;
  }
  await tx.execute(sql`
    UPDATE public.clubs
    SET access_state = ${state}, access_state_source = ${state === "active" ? null : "billing"}
    WHERE id = ${clubId}`);
  await audit.record(tx, {
    action: "club.access_state.changed",
    resourceType: "club",
    resourceId: clubId,
    changedFields: ["access_state", "access_state_source"],
  });
  return true;
}

const changed = (
  tx: Tx,
  clubId: string,
  change: "trial_ending" | "trial_ended" | "past_due" | "read_only" | "restored" | "renewed",
  key: string,
) =>
  outbox.publish(
    tx,
    "billing.subscription.changed",
    { clubId, change },
    { idempotencyKey: `billing:${change}:${clubId}:${key}` },
  );

const entitlementsChanged = (tx: Tx, clubId: string) =>
  outbox.publish(tx, "club.entitlements.changed", { clubId });

/** Back to active when no invoice is overdue any more (a payment or a credit note). */
export async function restoreIfSettled(tx: Tx, clubId: string, now: Date): Promise<boolean> {
  const sub = await lockSubscription(tx, clubId);
  if (!sub || (sub.status !== "past_due" && sub.status !== "read_only")) return false;
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM billing.invoices
    WHERE club_id = ${clubId} AND kind = 'invoice' AND status = 'open' AND due_at < ${now}`);
  if ((rows[0]?.n ?? 0) > 0) return false;
  await update(tx, sub, { status: "active", pastDueSince: null });
  await setAccess(tx, clubId, await clubFacts(tx, clubId), "active");
  await audit.record(tx, {
    action: "billing.subscription.status.changed",
    resourceType: "subscription",
    resourceId: sub.id,
    changedFields: ["status"],
  });
  await changed(tx, clubId, "restored", now.toISOString());
  await entitlementsChanged(tx, clubId);
  return true;
}

/** Does a set of plans cost anything in a currency and period? */
async function isPaid(
  tx: Tx,
  planIds: readonly string[],
  currency: string,
  period: BillingPeriod,
): Promise<boolean> {
  const prices = await planPrices(tx, planIds, currency, period);
  return [...prices.values()].some((p) => p > 0);
}

/**
 * Starts a new period on the subscription's (new) plans and issues its
 * invoice: from `from` (prorated) to the end of the calendar period.
 */
async function startPeriod(
  tx: Tx,
  settings: LedgerSettings,
  sub: Subscription,
  club: ClubFacts,
  from: Date,
  now: Date,
): Promise<Subscription> {
  const period = periodAt(from, sub.billingPeriod, club.timeZone);
  const next = await update(tx, sub, {
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  });
  if (next.status === "read_only") return next; // no new invoices while read-only (ADR 0045)
  await issueInvoice(tx, settings, {
    sub: next,
    period,
    lines: await recurringLines(tx, {
      planIds: plansOf(next.planId, next.addOnPlanIds),
      currency: next.currency,
      billingPeriod: next.billingPeriod,
      period,
      from,
      timeZone: club.timeZone,
    }),
    now,
  });
  return next;
}

/** The scheduled selection as the new plans (cleared afterwards). */
const selectionOf = (sub: Subscription) => ({
  planId: sub.scheduledPlanId ?? sub.planId,
  addOnPlanIds: sub.scheduledAddOnPlanIds ?? sub.addOnPlanIds,
  billingPeriod: sub.scheduledBillingPeriod ?? sub.billingPeriod,
});

const CLEARED = {
  scheduledPlanId: null,
  scheduledAddOnPlanIds: null,
  scheduledBillingPeriod: null,
  scheduledEffectiveAt: null,
} as const;

/** Ends a trial: the chosen plan when it can be invoiced, else the default plan. */
async function endTrial(
  tx: Tx,
  settings: LedgerSettings,
  sub: Subscription,
  club: ClubFacts,
  now: Date,
): Promise<Subscription> {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.clubId, sub.clubId));
  const chosen = sub.scheduledPlanId ? selectionOf(sub) : null;
  const paid = chosen
    ? await isPaid(
        tx,
        plansOf(chosen.planId, chosen.addOnPlanIds),
        sub.currency,
        chosen.billingPeriod,
      )
    : false;
  const plans =
    chosen && (!paid || accountComplete(account ?? null))
      ? chosen
      : {
          planId: await defaultPlanId(tx, settings.defaultPlan),
          addOnPlanIds: [] as string[],
          billingPeriod: sub.billingPeriod,
        };
  let next = await update(tx, sub, {
    ...plans,
    ...CLEARED,
    status: "active",
    trialReminderLevel: TRIAL_REMINDER_DAYS.length,
  });
  await audit.record(tx, {
    action: "billing.subscription.status.changed",
    resourceType: "subscription",
    resourceId: sub.id,
    changedFields: ["status", "plan_id", "add_on_plan_ids"],
  });
  next = await startPeriod(tx, settings, next, club, now, now);
  await changed(tx, sub.clubId, "trial_ended", sub.id);
  await entitlementsChanged(tx, sub.clubId);
  return next;
}

/**
 * An upgrade during a paid period: the new plans at once, the difference for
 * the rest of the period prorated on the next invoice (or invoiced now when
 * the current period was free).
 */
async function applyUpgrade(
  tx: Tx,
  settings: LedgerSettings,
  sub: Subscription,
  club: ClubFacts,
  now: Date,
): Promise<Subscription> {
  const target = selectionOf(sub);
  const start = sub.currentPeriodStart;
  const end = sub.currentPeriodEnd;
  let next = await update(tx, sub, { ...target, ...CLEARED });
  await entitlementsChanged(tx, sub.clubId);
  if (!start || !end || end.getTime() <= now.getTime())
    return startPeriod(tx, settings, next, club, now, now);
  const period = { start, end };
  const wasPaid = await isPaid(
    tx,
    plansOf(sub.planId, sub.addOnPlanIds),
    sub.currency,
    sub.billingPeriod,
  );
  if (!wasPaid) return startPeriod(tx, settings, next, club, now, now);
  // The difference for [now, end): the base plan's, and every added add-on
  // (removing an add-on is never an upgrade, see the API).
  const [oldPrices, newPrices] = await Promise.all([
    planPrices(tx, plansOf(sub.planId, sub.addOnPlanIds), sub.currency, sub.billingPeriod),
    planPrices(tx, plansOf(target.planId, target.addOnPlanIds), sub.currency, sub.billingPeriod),
  ]);
  const diffs: [string, number][] = [
    [target.planId, (newPrices.get(target.planId) ?? 0) - (oldPrices.get(sub.planId) ?? 0)],
    ...target.addOnPlanIds
      .filter((id) => !sub.addOnPlanIds.includes(id))
      .map((id): [string, number] => [id, newPrices.get(id) ?? 0]),
  ];
  const lines: Omit<DraftLine, "vatRateBp">[] = [];
  for (const [planId, diff] of diffs) {
    if (diff <= 0) continue;
    const amount = prorate(diff, period, now, club.timeZone);
    if (amount === 0) continue;
    lines.push({
      descriptionKey: "plan.upgrade",
      planId,
      quantity: 1,
      unitMinor: amount,
      amountMinor: amount,
      periodStart: now,
      periodEnd: end,
      proration: true,
    });
  }
  const nextPeriod = periodAt(end, sub.billingPeriod, club.timeZone);
  await addToDraft(tx, next, nextPeriod, lines);
  next = (await lockSubscription(tx, sub.clubId))!;
  return next;
}

/** At the period end: the scheduled change or cancellation, then the next period. */
async function renew(
  tx: Tx,
  settings: LedgerSettings,
  sub: Subscription,
  club: ClubFacts,
  now: Date,
): Promise<Subscription> {
  let next = sub;
  // Catch up after downtime, one period at a time (each invoiced once).
  for (let guard = 0; guard < 24; guard++) {
    if (next.currentPeriodEnd && next.currentPeriodEnd.getTime() > now.getTime()) break;
    const at = next.currentPeriodEnd ?? now;
    if (next.cancelAtPeriodEnd) {
      next = await update(tx, next, {
        planId: await defaultPlanId(tx, settings.defaultPlan),
        addOnPlanIds: [],
        cancelAtPeriodEnd: false,
        ...CLEARED,
      });
      await entitlementsChanged(tx, sub.clubId);
    } else if (next.scheduledEffectiveAt && next.scheduledEffectiveAt.getTime() <= at.getTime()) {
      next = await update(tx, next, { ...selectionOf(next), ...CLEARED });
      await entitlementsChanged(tx, sub.clubId);
    }
    const periodStart = at;
    next = await startPeriod(tx, settings, next, club, periodStart, now);
    await changed(tx, sub.clubId, "renewed", periodStart.toISOString());
  }
  return next;
}

/** Reminders and the status steps of overdue invoices (decision 8). */
async function dun(tx: Tx, sub: Subscription, club: ClubFacts, now: Date): Promise<void> {
  const overdue = await tx
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.clubId, sub.clubId),
        eq(billingInvoices.kind, "invoice"),
        eq(billingInvoices.status, "open"),
        sql`${billingInvoices.dueAt} < ${now}`,
      ),
    )
    .orderBy(asc(billingInvoices.dueAt));
  let current = sub;
  for (const invoice of overdue) {
    const days = daysBetween(invoice.dueAt!, now, club.timeZone);
    const level =
      days >= DUNNING_DAYS.readOnly
        ? 3
        : days >= DUNNING_DAYS.secondReminder
          ? 2
          : days >= DUNNING_DAYS.pastDue
            ? 1
            : 0;
    if (level <= invoice.reminderLevel) continue;
    await tx
      .update(billingInvoices)
      .set({ reminderLevel: level, lastRemindedAt: now })
      .where(eq(billingInvoices.id, invoice.id));
    // One email per step reached (a skipped step after downtime is not sent twice).
    if (level <= 2) {
      await outbox.publish(
        tx,
        "billing.invoice.overdue",
        { clubId: sub.clubId, invoiceId: invoice.id, level },
        { idempotencyKey: `billing:overdue:${invoice.id}:${level}` },
      );
    }
    if (level >= 1 && current.status === "active") {
      current = await update(tx, current, { status: "past_due", pastDueSince: now });
      await audit.record(tx, {
        action: "billing.subscription.status.changed",
        resourceType: "subscription",
        resourceId: sub.id,
        changedFields: ["status"],
      });
      await changed(tx, sub.clubId, "past_due", invoice.id);
      await entitlementsChanged(tx, sub.clubId);
    }
    if (level >= 3 && current.status === "past_due") {
      current = await update(tx, current, { status: "read_only" });
      await audit.record(tx, {
        action: "billing.subscription.status.changed",
        resourceType: "subscription",
        resourceId: sub.id,
        changedFields: ["status"],
      });
      await setAccess(tx, sub.clubId, club, "read_only");
      await changed(tx, sub.clubId, "read_only", invoice.id);
      await entitlementsChanged(tx, sub.clubId);
    }
  }
}

/**
 * Everything due for one club (billing:daily and the selection handler):
 * trial reminders and the trial's end, a selection that takes effect now,
 * period renewals with their invoices, and dunning. Idempotent.
 */
export async function runClub(
  tx: Tx,
  settings: LedgerSettings,
  clubId: string,
  now: Date,
): Promise<void> {
  let sub = await lockSubscription(tx, clubId);
  if (!sub || sub.status === "cancelled") return;
  const club = await clubFacts(tx, clubId);
  const due = (at: Date | null) => at !== null && at.getTime() <= now.getTime();

  if (sub.status === "trial") {
    if (due(sub.trialEndsAt) || due(sub.scheduledEffectiveAt)) {
      sub = await endTrial(tx, settings, sub, club, now);
    } else if (sub.trialEndsAt) {
      const left = (sub.trialEndsAt.getTime() - now.getTime()) / DAY_MS;
      const level = TRIAL_REMINDER_DAYS.filter((d) => left <= d).length;
      if (level > sub.trialReminderLevel) {
        sub = await update(tx, sub, { trialReminderLevel: level });
        await changed(tx, clubId, "trial_ending", `${sub.id}:${level}`);
      }
      return;
    }
  }
  // A selection taking effect now (upgrades); period-end changes wait for renew.
  const effective = sub.scheduledEffectiveAt;
  if (
    effective &&
    due(effective) &&
    !(sub.currentPeriodEnd && effective.getTime() >= sub.currentPeriodEnd.getTime())
  ) {
    sub = await applyUpgrade(tx, settings, sub, club, now);
  }
  if (sub.currentPeriodEnd === null) {
    sub = await startPeriod(tx, settings, sub, club, now, now);
  } else if (due(sub.currentPeriodEnd)) {
    sub = await renew(tx, settings, sub, club, now);
  }
  await dun(tx, sub, club, now);
}

/** The clubs with billing work at `now`, by club ID (batches; a system job). */
export async function dueClubs(
  tx: Tx,
  now: Date,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const { rows } = await tx.execute<{ club_id: string }>(
    sql`SELECT billing.due_clubs(${now}, ${after}::uuid, ${limit}) AS club_id`,
  );
  return rows.map((r) => r.club_id);
}

export const ledger = {
  issueInvoice,
  issueCreditNote,
  recordPayment,
  restoreIfSettled,
  runClub,
  dueClubs,
  balanceOf,
  planPrices,
  accountComplete,
};
