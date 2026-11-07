// SPDX-License-Identifier: AGPL-3.0-only
// The billing schema (migrations/0006). Row-level security decides who sees
// what: club managers and treasurers their club's subscription, operators
// everything, jobs (the entitlement source) the club they work in.

import { and, asc, desc, eq, inArray, sql, tables, type Tx } from "@clubadmin/db";
import { uuidv7 } from "@clubadmin/shared";

const { billingPlans, billingPlanEntitlements, billingSubscriptions } = tables;

export type PlanRow = typeof billingPlans.$inferSelect;
export type PlanEntitlementRow = typeof billingPlanEntitlements.$inferSelect;
export type SubscriptionRow = typeof billingSubscriptions.$inferSelect;

export async function listPlans(tx: Tx): Promise<PlanRow[]> {
  return tx.select().from(billingPlans).orderBy(billingPlans.kind, billingPlans.priceMinor);
}

export async function findPlansByKey(tx: Tx, keys: readonly string[]): Promise<PlanRow[]> {
  if (keys.length === 0) return [];
  return tx
    .select()
    .from(billingPlans)
    .where(inArray(billingPlans.key, [...keys]));
}

export async function findPlansById(tx: Tx, ids: readonly string[]): Promise<PlanRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(billingPlans)
    .where(inArray(billingPlans.id, [...ids]));
}

export async function planEntitlements(
  tx: Tx,
  planIds: readonly string[],
): Promise<PlanEntitlementRow[]> {
  if (planIds.length === 0) return [];
  return tx
    .select()
    .from(billingPlanEntitlements)
    .where(inArray(billingPlanEntitlements.planId, [...planIds]));
}

export async function findSubscription(tx: Tx, clubId: string): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.clubId, clubId));
  return row ?? null;
}

export async function lockSubscription(tx: Tx, clubId: string): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.clubId, clubId))
    .for("update");
  return row ?? null;
}

export async function insertSubscription(
  tx: Tx,
  values: Pick<SubscriptionRow, "clubId" | "planId" | "addOnPlanIds" | "status"> &
    Partial<Pick<SubscriptionRow, "trialEndsAt" | "currentPeriodStart" | "currency">>,
): Promise<string> {
  const id = uuidv7();
  await tx.insert(billingSubscriptions).values({ id, ...values });
  return id;
}

export async function updateSubscription(
  tx: Tx,
  clubId: string,
  values: Partial<Omit<SubscriptionRow, "id" | "clubId">>,
): Promise<void> {
  await tx
    .update(billingSubscriptions)
    .set(values)
    .where(and(eq(billingSubscriptions.clubId, clubId)));
}

// --- P1.13: prices, accounts, invoices, payments, operator lists ----------------------------

const {
  billingPlanPrices,
  billingAccounts,
  billingInvoices,
  billingInvoiceLines,
  billingPayments,
} = tables;

export type PlanPriceRow = typeof billingPlanPrices.$inferSelect;
export type AccountRow = typeof billingAccounts.$inferSelect;
export type InvoiceRow = typeof billingInvoices.$inferSelect;
export type InvoiceLineRow = typeof billingInvoiceLines.$inferSelect;
export type PaymentRow = typeof billingPayments.$inferSelect;

export async function activePrices(tx: Tx, planIds: readonly string[]): Promise<PlanPriceRow[]> {
  if (planIds.length === 0) return [];
  return tx
    .select()
    .from(billingPlanPrices)
    .where(and(inArray(billingPlanPrices.planId, [...planIds]), eq(billingPlanPrices.active, true)));
}

export async function insertPrice(
  tx: Tx,
  values: Pick<PlanPriceRow, "planId" | "currency" | "period" | "priceMinor">,
): Promise<void> {
  await tx
    .update(billingPlanPrices)
    .set({ active: false })
    .where(
      and(
        eq(billingPlanPrices.planId, values.planId),
        eq(billingPlanPrices.currency, values.currency),
        eq(billingPlanPrices.period, values.period),
        eq(billingPlanPrices.active, true),
      ),
    );
  await tx.insert(billingPlanPrices).values({ id: uuidv7(), active: true, ...values });
}

export async function deactivatePrice(
  tx: Tx,
  planId: string,
  currency: string,
  period: "month" | "year",
): Promise<void> {
  await tx
    .update(billingPlanPrices)
    .set({ active: false })
    .where(
      and(
        eq(billingPlanPrices.planId, planId),
        eq(billingPlanPrices.currency, currency),
        eq(billingPlanPrices.period, period),
        eq(billingPlanPrices.active, true),
      ),
    );
}

export async function insertPlan(
  tx: Tx,
  values: Pick<PlanRow, "key" | "name" | "kind" | "currency" | "priceMinor" | "period">,
): Promise<string> {
  const id = uuidv7();
  await tx.insert(tables.billingPlans).values({ id, active: true, ...values });
  return id;
}

export async function updatePlan(
  tx: Tx,
  planId: string,
  values: Partial<Pick<PlanRow, "name" | "active">>,
): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await tx.update(tables.billingPlans).set(values).where(eq(tables.billingPlans.id, planId));
}

/** Replaces the plan's entitlement rows for the given keys. */
export async function setPlanEntitlements(
  tx: Tx,
  planId: string,
  features: Record<string, boolean>,
  limits: Record<string, number | null>,
): Promise<void> {
  const keys = [...Object.keys(features), ...Object.keys(limits)];
  if (keys.length === 0) return;
  await tx.execute(sql`
    DELETE FROM billing.plan_entitlements
    WHERE plan_id = ${planId} AND key = ANY (${`{${keys.join(",")}}`}::text[])`);
  await tx.insert(billingPlanEntitlements).values([
    ...Object.entries(features).map(([key, enabled]) => ({
      id: uuidv7(),
      planId,
      key,
      kind: "feature" as const,
      enabled,
      limitValue: null,
    })),
    ...Object.entries(limits).map(([key, limitValue]) => ({
      id: uuidv7(),
      planId,
      key,
      kind: "limit" as const,
      enabled: null,
      limitValue,
    })),
  ]);
}

export async function findAccount(tx: Tx, clubId: string): Promise<AccountRow | null> {
  const [row] = await tx.select().from(billingAccounts).where(eq(billingAccounts.clubId, clubId));
  return row ?? null;
}

export async function upsertAccount(
  tx: Tx,
  clubId: string,
  values: Partial<Omit<AccountRow, "id" | "clubId" | "updatedAt">> & { legalName: string },
): Promise<void> {
  await tx
    .insert(billingAccounts)
    .values({ id: uuidv7(), clubId, ...values })
    .onConflictDoUpdate({ target: billingAccounts.clubId, set: values });
}

export async function updateAccount(
  tx: Tx,
  clubId: string,
  values: Partial<Omit<AccountRow, "id" | "clubId" | "updatedAt">>,
): Promise<void> {
  await tx.update(billingAccounts).set(values).where(eq(billingAccounts.clubId, clubId));
}

/** The club's issued invoices and credit notes, newest first (keyset by id; uuidv7). */
export async function listInvoices(
  tx: Tx,
  clubId: string,
  cursor: string | null,
  limit: number,
): Promise<InvoiceRow[]> {
  return tx
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.clubId, clubId),
        sql`${billingInvoices.status} <> 'draft'`,
        cursor ? sql`${billingInvoices.id} < ${cursor}` : undefined,
      ),
    )
    .orderBy(desc(billingInvoices.id))
    .limit(limit);
}

export async function findInvoice(tx: Tx, invoiceId: string): Promise<InvoiceRow | null> {
  const [row] = await tx.select().from(billingInvoices).where(eq(billingInvoices.id, invoiceId));
  return row ?? null;
}

export async function invoiceLines(tx: Tx, invoiceId: string): Promise<InvoiceLineRow[]> {
  return tx
    .select()
    .from(billingInvoiceLines)
    .where(eq(billingInvoiceLines.invoiceId, invoiceId))
    .orderBy(asc(billingInvoiceLines.id));
}

export async function invoicePayments(tx: Tx, invoiceIds: readonly string[]): Promise<PaymentRow[]> {
  if (invoiceIds.length === 0) return [];
  return tx
    .select()
    .from(billingPayments)
    .where(inArray(billingPayments.invoiceId, [...invoiceIds]))
    .orderBy(asc(billingPayments.id));
}

/** Credit notes of invoices (their totals are negative). */
export async function creditNotesOf(tx: Tx, invoiceIds: readonly string[]): Promise<InvoiceRow[]> {
  if (invoiceIds.length === 0) return [];
  return tx
    .select()
    .from(billingInvoices)
    .where(
      and(
        inArray(billingInvoices.creditedInvoiceId, [...invoiceIds]),
        sql`${billingInvoices.status} <> 'void'`,
      ),
    );
}

/** What the club owes: the balance of its open invoices. */
export async function balanceDue(tx: Tx, clubId: string): Promise<number> {
  const { rows } = await tx.execute<{ due: string | null }>(sql`
    SELECT sum(i.total_minor
      - coalesce((SELECT sum(p.amount_minor) FROM billing.payments p
                  WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0)
      + coalesce((SELECT sum(c.total_minor) FROM billing.invoices c
                  WHERE c.credited_invoice_id = i.id AND c.status <> 'void'), 0)) AS due
    FROM billing.invoices i
    WHERE i.club_id = ${clubId} AND i.kind = 'invoice' AND i.status = 'open'`);
  return Number(rows[0]?.due ?? 0);
}

export interface OperatorSubscriptionRow {
  clubId: string;
  clubName: string;
  country: string;
  accessState: string;
  subscription: SubscriptionRow;
  paymentMethod: "invoice" | "card" | null;
  balanceDueMinor: number;
}

/** Subscriptions across clubs (operators), by subscription id (keyset). */
export async function operatorSubscriptions(
  tx: Tx,
  filter: { status?: string | undefined; planId?: string | undefined },
  cursor: string | null,
  limit: number,
): Promise<OperatorSubscriptionRow[]> {
  const rows = await tx
    .select({
      subscription: billingSubscriptions,
      clubName: sql<string>`c.name`,
      country: sql<string>`c.country`,
      accessState: sql<string>`c.access_state`,
      paymentMethod: billingAccounts.paymentMethod,
      balanceDueMinor: sql<string>`coalesce((
        SELECT sum(i.total_minor
          - coalesce((SELECT sum(p.amount_minor) FROM billing.payments p
                      WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0)
          + coalesce((SELECT sum(cn.total_minor) FROM billing.invoices cn
                      WHERE cn.credited_invoice_id = i.id AND cn.status <> 'void'), 0))
        FROM billing.invoices i
        WHERE i.club_id = ${billingSubscriptions.clubId} AND i.kind = 'invoice' AND i.status = 'open'), 0)`,
    })
    .from(billingSubscriptions)
    .innerJoin(sql`public.clubs c`, sql`c.id = ${billingSubscriptions.clubId}`)
    .leftJoin(billingAccounts, eq(billingAccounts.clubId, billingSubscriptions.clubId))
    .where(
      and(
        filter.status ? eq(billingSubscriptions.status, filter.status as SubscriptionRow["status"]) : undefined,
        filter.planId ? eq(billingSubscriptions.planId, filter.planId) : undefined,
        cursor ? sql`${billingSubscriptions.id} > ${cursor}` : undefined,
      ),
    )
    .orderBy(asc(billingSubscriptions.id))
    .limit(limit);
  return rows.map((r) => ({
    clubId: r.subscription.clubId,
    clubName: r.clubName,
    country: r.country,
    accessState: r.accessState,
    subscription: r.subscription,
    paymentMethod: r.paymentMethod,
    balanceDueMinor: Number(r.balanceDueMinor),
  }));
}

export interface ClubRef {
  id: string;
  name: string;
  country: string;
}

export async function clubRefs(tx: Tx, clubIds: readonly string[]): Promise<Map<string, ClubRef>> {
  if (clubIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; name: string; country: string }>(sql`
    SELECT id, name, country FROM public.clubs WHERE id = ANY (${`{${[...new Set(clubIds)].join(",")}}`}::uuid[])`);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Issued invoices and credit notes across clubs (operators), newest first. */
export async function operatorInvoices(
  tx: Tx,
  filter: { status?: string | undefined; from?: string | undefined; to?: string | undefined },
  cursor: string | null,
  limit: number,
): Promise<InvoiceRow[]> {
  return tx
    .select()
    .from(billingInvoices)
    .where(
      and(
        sql`${billingInvoices.issuedAt} IS NOT NULL`,
        filter.status ? eq(billingInvoices.status, filter.status as InvoiceRow["status"]) : undefined,
        filter.from ? sql`${billingInvoices.issuedAt} >= ${filter.from}::date` : undefined,
        filter.to ? sql`${billingInvoices.issuedAt} < ${filter.to}::date + 1` : undefined,
        cursor
          ? sql`(${billingInvoices.issuedAt}, ${billingInvoices.id}) < (SELECT issued_at, id FROM billing.invoices WHERE id = ${cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(billingInvoices.issuedAt), desc(billingInvoices.id))
    .limit(limit);
}

/** Payments across clubs (operators), newest first by id. */
export async function operatorPayments(
  tx: Tx,
  filter: { from?: string | undefined; to?: string | undefined },
  cursor: string | null,
  limit: number,
): Promise<(PaymentRow & { invoiceNumber: string | null })[]> {
  const rows = await tx
    .select({ payment: billingPayments, invoiceNumber: billingInvoices.number })
    .from(billingPayments)
    .innerJoin(billingInvoices, eq(billingInvoices.id, billingPayments.invoiceId))
    .where(
      and(
        filter.from ? sql`${billingPayments.recordedAt} >= ${filter.from}::date` : undefined,
        filter.to ? sql`${billingPayments.recordedAt} < ${filter.to}::date + 1` : undefined,
        cursor ? sql`${billingPayments.id} < ${cursor}` : undefined,
      ),
    )
    .orderBy(desc(billingPayments.id))
    .limit(limit);
  return rows.map((r) => ({ ...r.payment, invoiceNumber: r.invoiceNumber }));
}
