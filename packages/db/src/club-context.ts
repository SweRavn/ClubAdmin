// SPDX-License-Identifier: AGPL-3.0-only
// Switching the club of an open transaction. Only for operations that must
// change one person's rows in several clubs atomically (merging duplicate
// people); everything else uses one withTenant transaction per club.
// Row-level security still applies: in each club, only that club's rows.

import { isUuid } from "@clubadmin/shared";
import { sql } from "drizzle-orm";

import type { Tx } from "./database.ts";

export async function inClub<T>(tx: Tx, clubId: string, fn: () => Promise<T>): Promise<T> {
  if (!isUuid(clubId)) throw new Error("clubId must be a UUID");
  const { rows } = await tx.execute<{ previous: string | null }>(
    sql`SELECT current_setting('app.club_id', true) AS previous, set_config('app.club_id', ${clubId}, true)`,
  );
  const previous = rows[0]?.previous ?? "";
  // On error the transaction is aborted and rolls back; nothing to restore.
  const result = await fn();
  await tx.execute(sql`SELECT set_config('app.club_id', ${previous}, true)`);
  return result;
}
