// SPDX-License-Identifier: AGPL-3.0-only
import { eq, schema, sql, type Tx } from "@clubadmin/db";

const { accounts, accountInvitations } = schema;

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

export async function findBySubject(tx: Tx, idpSubject: string): Promise<AccountRow | null> {
  const [row] = await tx.select().from(accounts).where(eq(accounts.idpSubject, idpSubject));
  return row ?? null;
}

export async function findByPersonId(tx: Tx, personId: string): Promise<AccountRow | null> {
  const [row] = await tx.select().from(accounts).where(eq(accounts.personId, personId));
  return row ?? null;
}

export async function listAll(tx: Tx): Promise<{ personId: string; email: string }[]> {
  return tx.select({ personId: accounts.personId, email: accounts.email }).from(accounts);
}

export type AccountInvitationRow = typeof accountInvitations.$inferSelect;

export async function insertInvitation(
  tx: Tx,
  values: typeof accountInvitations.$inferInsert,
): Promise<AccountInvitationRow> {
  const [row] = await tx.insert(accountInvitations).values(values).returning();
  return row!;
}

/** Valid invitation for a token hash (SECURITY DEFINER; the holder is not linked to the person yet). */
export async function findInvitation(
  tx: Tx,
  tokenHash: string,
): Promise<{ invitationId: string; personId: string; email: string } | null> {
  const { rows } = await tx.execute<{ invitation_id: string; person_id: string; email: string }>(
    sql`SELECT * FROM app.find_account_invitation(${tokenHash})`,
  );
  const row = rows[0];
  return row
    ? { invitationId: row.invitation_id, personId: row.person_id, email: row.email }
    : null;
}

export async function markInvitationAccepted(tx: Tx, invitationId: string): Promise<number> {
  const rows = await tx
    .update(accountInvitations)
    .set({ acceptedAt: new Date() })
    .where(eq(accountInvitations.id, invitationId))
    .returning({ id: accountInvitations.id });
  return rows.length;
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

export async function actorHasClubRole(tx: Tx, roles: readonly string[]): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.has_club_role(string_to_array(${roles.join(",")}, ',')) AS ok`,
  );
  return rows[0]?.ok === true;
}

/** People among these who have a login (app.person_has_account: only reachable people). */
export async function peopleWithAccount(
  tx: Tx,
  personIds: readonly string[],
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM unnest(string_to_array(${personIds.join(",")}, ',')::uuid[]) AS id
    WHERE app.person_has_account(id)`);
  return new Set(rows.map((r) => r.id));
}
