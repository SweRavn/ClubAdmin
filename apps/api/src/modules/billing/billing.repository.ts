// SPDX-License-Identifier: AGPL-3.0-only
// The billing schema (migrations/0006). Row-level security decides who sees
// what: club managers and treasurers their club's subscription, operators
// everything, jobs (the entitlement source) the club they work in.

import { and, eq, inArray, tables, type Tx } from "@clubadmin/db";
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
    Partial<Pick<SubscriptionRow, "trialEndsAt" | "currentPeriodStart">>,
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
