// SPDX-License-Identifier: AGPL-3.0-only
// Clubs on a plan with the given features, for tests that CI also runs with
// BILLING_ENABLED=true (P0.12): with billing off the rows are unused and the
// installation's FEATURE_* flags decide.

import type { TestDatabase } from "@clubadmin/db/testing";

export async function subscribeToFeatures(
  t: TestDatabase,
  clubIds: readonly string[],
  features: readonly string[],
): Promise<void> {
  const key = `test_${Math.random().toString(36).slice(2, 10)}`;
  await t.query(
    "admin",
    `WITH p AS (
       INSERT INTO billing.plans (key, name, kind, currency, price_minor)
       VALUES ($1, $1, 'base', 'SEK', 0) RETURNING id),
     e AS (
       INSERT INTO billing.plan_entitlements (plan_id, key, kind, enabled)
       SELECT p.id, f, 'feature', true FROM p, unnest($2::text[]) AS f)
     INSERT INTO billing.subscriptions (club_id, plan_id, status)
     SELECT c, p.id, 'active' FROM p, unnest($3::uuid[]) AS c
     ON CONFLICT (club_id) DO UPDATE SET plan_id = EXCLUDED.plan_id`,
    [key, features, clubIds],
  );
}
