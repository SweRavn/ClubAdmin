// SPDX-License-Identifier: AGPL-3.0-only
// Storage of wrapped field-encryption data keys (crypto.data_keys). The keys
// are wrapped by a master key outside the database; wrapping and unwrapping
// happen in @clubadmin/server-kit/crypto. One active key per club, plus one
// global key (clubId null) for global tables.

import { uuidv7 } from "@clubadmin/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "./database.ts";
import { dataKeys } from "./infra/tables.ts";

export interface StoredDataKey {
  id: string;
  clubId: string | null;
  wrappedKey: string;
}

/** The active data key of a club (or the global one), or null. */
async function findActive(tx: Tx, clubId: string | null): Promise<StoredDataKey | null> {
  const [row] = await tx
    .select({ id: dataKeys.id, clubId: dataKeys.clubId, wrappedKey: dataKeys.wrappedKey })
    .from(dataKeys)
    .where(
      and(
        clubId === null ? isNull(dataKeys.clubId) : eq(dataKeys.clubId, clubId),
        isNull(dataKeys.retiredAt),
      ),
    );
  return row ?? null;
}

async function findById(tx: Tx, id: string): Promise<StoredDataKey | null> {
  const [row] = await tx
    .select({ id: dataKeys.id, clubId: dataKeys.clubId, wrappedKey: dataKeys.wrappedKey })
    .from(dataKeys)
    .where(eq(dataKeys.id, id));
  return row ?? null;
}

/**
 * Returns the active key, creating it with `wrap(newId)` if there is none.
 * Concurrent creators race on the unique index; the loser reads the winner's key.
 */
async function getOrCreateActive(
  tx: Tx,
  clubId: string | null,
  wrap: (id: string) => string,
): Promise<StoredDataKey> {
  const existing = await findActive(tx, clubId);
  if (existing) return existing;
  const id = uuidv7();
  await tx.execute(sql`
    INSERT INTO crypto.data_keys (id, club_id, wrapped_key)
    VALUES (${id}, ${clubId}, ${wrap(id)})
    ON CONFLICT ((coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE retired_at IS NULL
    DO NOTHING`);
  const active = await findActive(tx, clubId);
  if (!active) throw new Error("data key not visible after creation");
  return active;
}

export const dataKeyStore = { findActive, findById, getOrCreateActive };
