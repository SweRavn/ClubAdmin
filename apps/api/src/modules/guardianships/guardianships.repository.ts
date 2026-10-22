// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull, isNull, schema, sql, type Tx } from "@clubadmin/db";

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

/**
 * Accepts through the SECURITY DEFINER function (the invitee cannot read the
 * invitation yet) with the caller's login email, which must match.
 */
export async function acceptInvitation(
  tx: Tx,
  tokenHash: string,
  email: string,
): Promise<{
  status: "accepted" | "invalid" | "email_mismatch" | "exists";
  guardianshipId: string | null;
}> {
  const { rows } = await tx.execute<{
    status: "accepted" | "invalid" | "email_mismatch" | "exists";
    guardianship_id: string | null;
  }>(sql`SELECT * FROM app.accept_guardian_invitation(${tokenHash}, ${email})`);
  return { status: rows[0]?.status ?? "invalid", guardianshipId: rows[0]?.guardianship_id ?? null };
}

export async function invitationOfGuardianship(
  tx: Tx,
  guardianshipId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: guardianInvitations.id })
    .from(guardianInvitations)
    .where(eq(guardianInvitations.guardianshipId, guardianshipId));
  return row?.id ?? null;
}

export async function lockInvitation(tx: Tx, id: string): Promise<GuardianInvitationRow | null> {
  const [row] = await tx
    .select()
    .from(guardianInvitations)
    .where(eq(guardianInvitations.id, id))
    .for("update");
  return row ?? null;
}

export async function updateInvitation(
  tx: Tx,
  id: string,
  values: Partial<typeof guardianInvitations.$inferInsert>,
): Promise<void> {
  await tx.update(guardianInvitations).set(values).where(eq(guardianInvitations.id, id));
}

/** By token hash (guardian_invitations_token_unique); system transactions only. */
export async function findInvitationByTokenHash(
  tx: Tx,
  tokenHash: string,
): Promise<GuardianInvitationRow | null> {
  const [row] = await tx
    .select()
    .from(guardianInvitations)
    .where(eq(guardianInvitations.tokenHash, tokenHash));
  return row ?? null;
}

/** Unaccepted, unrevoked, unexpired invitations for a ward (guardian_invitations_ward_idx). */
export function pendingInvitationsOf(tx: Tx, wardPersonId: string) {
  return tx
    .select()
    .from(guardianInvitations)
    .where(
      and(
        eq(guardianInvitations.wardPersonId, wardPersonId),
        isNull(guardianInvitations.acceptedAt),
        isNull(guardianInvitations.revokedAt),
        sql`${guardianInvitations.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(guardianInvitations.id));
}

/** The ward's open guardianships flagged at the adult age (an ended guardian is no longer reachable). */
export function adultFlaggedOf(tx: Tx, wardPersonId: string) {
  return tx
    .select()
    .from(guardianships)
    .where(
      and(
        eq(guardianships.wardPersonId, wardPersonId),
        isNotNull(guardianships.wardAdultFlaggedAt),
        isNull(guardianships.validTo),
      ),
    )
    .orderBy(asc(guardianships.id));
}

export async function actorHasClubRole(tx: Tx, roles: readonly string[]): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.has_club_role(string_to_array(${roles.join(",")}, ',')) AS ok`,
  );
  return rows[0]?.ok === true;
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
