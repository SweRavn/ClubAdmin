// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { ClubRole } from "@clubadmin/shared";

const {
  clubRoleAssignments: roles,
  clubManagerHandovers: handovers,
  clubManagerReassignments: reassignments,
} = schema;

export type RoleAssignmentRow = typeof roles.$inferSelect;
export type HandoverRow = typeof handovers.$inferSelect;

export async function insertAssignment(
  tx: Tx,
  values: typeof roles.$inferInsert,
): Promise<RoleAssignmentRow> {
  const [row] = await tx.insert(roles).values(values).returning();
  return row!;
}

export async function findActiveAssignment(
  tx: Tx,
  clubId: string,
  personId: string,
  role: ClubRole,
): Promise<RoleAssignmentRow | null> {
  const [row] = await tx
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.clubId, clubId),
        eq(roles.personId, personId),
        eq(roles.role, role),
        isNull(roles.validTo),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function activeAssignmentsOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<RoleAssignmentRow[]> {
  return tx
    .select()
    .from(roles)
    .where(and(eq(roles.clubId, clubId), eq(roles.personId, personId), isNull(roles.validTo)))
    .for("update");
}

export async function activeHolders(tx: Tx, clubId: string, role: ClubRole): Promise<string[]> {
  const rows = await tx
    .select({ personId: roles.personId })
    .from(roles)
    .where(and(eq(roles.clubId, clubId), eq(roles.role, role), isNull(roles.validTo)));
  return rows.map((r) => r.personId);
}

export async function endAssignment(tx: Tx, id: string, endedBy: string | null): Promise<void> {
  await tx
    .update(roles)
    .set({ validTo: sql`now()`, endedByPersonId: endedBy })
    .where(eq(roles.id, id));
}

export async function insertHandover(
  tx: Tx,
  values: typeof handovers.$inferInsert,
): Promise<HandoverRow> {
  const [row] = await tx.insert(handovers).values(values).returning();
  return row!;
}

export async function lockHandover(tx: Tx, id: string): Promise<HandoverRow | null> {
  const [row] = await tx.select().from(handovers).where(eq(handovers.id, id)).for("update");
  return row ?? null;
}

export async function cancelOpenHandovers(
  tx: Tx,
  clubId: string,
  fromPersonId: string,
): Promise<number> {
  const rows = await tx
    .update(handovers)
    .set({ status: "cancelled", decidedAt: sql`now()` })
    .where(
      and(
        eq(handovers.clubId, clubId),
        eq(handovers.fromPersonId, fromPersonId),
        eq(handovers.status, "proposed"),
      ),
    )
    .returning({ id: handovers.id });
  return rows.length;
}

export async function setHandoverStatus(
  tx: Tx,
  id: string,
  status: HandoverRow["status"],
): Promise<void> {
  await tx
    .update(handovers)
    .set({ status, decidedAt: sql`now()` })
    .where(eq(handovers.id, id));
}

export async function activeAssignments(
  tx: Tx,
  clubId: string,
): Promise<{ personId: string; role: ClubRole }[]> {
  return tx
    .select({ personId: roles.personId, role: roles.role })
    .from(roles)
    .where(and(eq(roles.clubId, clubId), isNull(roles.validTo)));
}

/** Current holders of a role with the start of their assignment, longest first. */
export async function activeHoldersSince(
  tx: Tx,
  clubId: string,
  role: ClubRole,
): Promise<{ personId: string; validFrom: Date }[]> {
  return tx
    .select({ personId: roles.personId, validFrom: roles.validFrom })
    .from(roles)
    .where(and(eq(roles.clubId, clubId), eq(roles.role, role), isNull(roles.validTo)))
    .orderBy(roles.validFrom, roles.personId);
}

/** Open, unexpired hand-overs to or from the person, in all clubs (own_relationships). */
export async function openHandoversOfPerson(tx: Tx, personId: string): Promise<HandoverRow[]> {
  return tx
    .select()
    .from(handovers)
    .where(
      and(
        eq(handovers.status, "proposed"),
        sql`${handovers.expiresAt} > now()`,
        sql`(${handovers.fromPersonId} = ${personId} OR ${handovers.toPersonId} = ${personId})`,
      ),
    )
    .orderBy(handovers.createdAt)
    .limit(50);
}

export async function insertReassignment(
  tx: Tx,
  values: typeof reassignments.$inferInsert,
): Promise<string> {
  const [row] = await tx.insert(reassignments).values(values).returning({ id: reassignments.id });
  return row!.id;
}
