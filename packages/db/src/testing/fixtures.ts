// SPDX-License-Identifier: AGPL-3.0-only
// A sample club-owned table, set up exactly like a real one would be in a migration.
import type { TestDatabase } from "./index.ts";

export const SAMPLE_TABLE = "public.test_items";

export async function createSampleTable(t: TestDatabase): Promise<void> {
  await t.query(
    "owner",
    `CREATE TABLE public.test_items (
       id uuid PRIMARY KEY DEFAULT uuidv7(),
       club_id uuid NOT NULL,
       name text NOT NULL,
       secret text,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     );
     SELECT app.enable_tenant_rls('public.test_items');
     SELECT app.enable_updated_at('public.test_items');
     SELECT history.enable_history('public.test_items', redact => ARRAY['secret']);`,
  );
}
