// SPDX-License-Identifier: AGPL-3.0-only
import { eq, schema, type Tx } from "@clubadmin/db";

const { accounts } = schema;

export type AccountRow = typeof accounts.$inferSelect;

export async function insertAccount(
  tx: Tx,
  values: typeof accounts.$inferInsert,
): Promise<AccountRow> {
  const [row] = await tx.insert(accounts).values(values).returning();
  return row!;
}

export async function findByPerson(tx: Tx, personId: string): Promise<AccountRow | null> {
  const [row] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.personId, personId))
    .for("update");
  return row ?? null;
}

export async function updateAccount(
  tx: Tx,
  id: string,
  values: Partial<typeof accounts.$inferInsert>,
): Promise<void> {
  await tx.update(accounts).set(values).where(eq(accounts.id, id));
}
