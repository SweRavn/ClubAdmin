// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, schema, sql, type Tx } from "@clubadmin/db";

const { guardianships, guardianInvitations } = schema;

export type GuardianshipRow = typeof guardianships.$inferSelect;
export type GuardianInvitationRow = typeof guardianInvitations.$inferSelect;

export async function insertGuardianship(
  tx: Tx,
  values: typeof guardianships.$inferInsert,
): Promise<GuardianshipRow> {
  const [row] = await tx.insert(guardianships).values(values).returning();
  return row!;
}

export async function findGuardianship(tx: Tx, id: string): Promise<GuardianshipRow | null> {
  const [row] = await tx.select().from(guardianships).where(eq(guardianships.id, id)).for("update");
  return row ?? null;
}

export async function updateGuardianship(
  tx: Tx,
  id: string,
  values: Partial<typeof guardianships.$inferInsert>,
): Promise<void> {
  await tx.update(guardianships).set(values).where(eq(guardianships.id, id));
}

/** "Guardians of person": guardianships_ward_idx. */
export function guardiansOfQuery(tx: Tx, wardPersonId: string) {
  return tx
    .select()
    .from(guardianships)
    .where(and(eq(guardianships.wardPersonId, wardPersonId), isNull(guardianships.validTo)))
    .orderBy(guardianships.id);
}

/** "Wards of person": guardianships_guardian_idx. */
export function wardsOfQuery(tx: Tx, guardianPersonId: string) {
  return tx
    .select()
    .from(guardianships)
    .where(and(eq(guardianships.guardianPersonId, guardianPersonId), isNull(guardianships.validTo)))
    .orderBy(guardianships.id);
}

export async function insertInvitation(
  tx: Tx,
  values: typeof guardianInvitations.$inferInsert,
): Promise<GuardianInvitationRow> {
  const [row] = await tx.insert(guardianInvitations).values(values).returning();
  return row!;
}

/** Accepts through the SECURITY DEFINER function (the invitee cannot read the invitation yet). */
export async function acceptInvitation(tx: Tx, tokenHash: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string | null }>(
    sql`SELECT app.accept_guardian_invitation(${tokenHash}) AS id`,
  );
  return rows[0]?.id ?? null;
}

export async function actorIsFullGuardianOf(tx: Tx, personId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.is_full_guardian_of(${personId}) AS ok`,
  );
  return rows[0]?.ok === true;
}

export async function actorIsClubManager(tx: Tx): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT app.is_club_manager() AS ok`);
  return rows[0]?.ok === true;
}
