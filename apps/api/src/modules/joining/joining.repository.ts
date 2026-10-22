// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull, schema, sql, type Tx } from "@clubadmin/db";
import type { JoinPolicy, JoinRequestStatus } from "@clubadmin/shared";

const { joinRequests, invitations, invitationAcceptances } = schema;

export type JoinRequestRow = typeof joinRequests.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;

// --- Club search (app.search_clubs, migration 0007) -----------------------

export interface ClubListingRow {
  id: string;
  name: string;
  shortName: string | null;
  city: string | null;
  country: string;
  joinPolicy: JoinPolicy;
}

export async function searchClubs(
  tx: Tx,
  query: { q: string | null; country: string | null; cursor: string | null; limit: number },
): Promise<ClubListingRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    short_name: string | null;
    city: string | null;
    country: string;
    join_policy: JoinPolicy;
  }>(
    sql`SELECT * FROM app.search_clubs(${query.q}, ${query.country}, ${query.cursor}::uuid, ${query.limit})`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    city: r.city,
    country: r.country,
    joinPolicy: r.join_policy,
  }));
}

// --- Join requests ---------------------------------------------------------

export async function insertJoinRequest(
  tx: Tx,
  values: typeof joinRequests.$inferInsert,
): Promise<JoinRequestRow> {
  const [row] = await tx.insert(joinRequests).values(values).returning();
  return row!;
}

export async function lockJoinRequest(tx: Tx, id: string): Promise<JoinRequestRow | null> {
  const [row] = await tx.select().from(joinRequests).where(eq(joinRequests.id, id)).for("update");
  return row ?? null;
}

export async function findPendingJoinRequest(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<JoinRequestRow | null> {
  const [row] = await tx
    .select()
    .from(joinRequests)
    .where(
      and(
        eq(joinRequests.clubId, clubId),
        eq(joinRequests.personId, personId),
        eq(joinRequests.status, "pending"),
      ),
    );
  return row ?? null;
}

export async function decideJoinRequest(
  tx: Tx,
  id: string,
  values: {
    status: JoinRequestStatus;
    decidedByPersonId: string | null;
    decisionMessage?: string | null;
  },
): Promise<void> {
  await tx
    .update(joinRequests)
    .set({ ...values, decidedAt: new Date() })
    .where(eq(joinRequests.id, id));
}

/** A page of the club's requests in a status, oldest first (join_requests_club_status_idx). */
export async function clubJoinRequestsPage(
  tx: Tx,
  clubId: string,
  status: JoinRequestStatus,
  page: { cursor: string | null; limit: number },
): Promise<{ items: JoinRequestRow[]; cursorFound: boolean }> {
  let after: { createdAt: Date; id: string } | null = null;
  if (page.cursor) {
    const [row] = await tx
      .select({ createdAt: joinRequests.createdAt, id: joinRequests.id })
      .from(joinRequests)
      .where(and(eq(joinRequests.id, page.cursor), eq(joinRequests.clubId, clubId)));
    if (!row) return { items: [], cursorFound: false };
    after = row;
  }
  const items = await tx
    .select()
    .from(joinRequests)
    .where(
      and(
        eq(joinRequests.clubId, clubId),
        eq(joinRequests.status, status),
        after
          ? sql`(${joinRequests.createdAt}, ${joinRequests.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(joinRequests.createdAt), asc(joinRequests.id))
    .limit(page.limit);
  return { items, cursorFound: true };
}

/**
 * The caller's and their wards' requests across clubs (own_relationships),
 * pending first, then the latest decided ones.
 */
export async function myJoinRequests(
  tx: Tx,
  personIds: readonly string[],
): Promise<JoinRequestRow[]> {
  if (personIds.length === 0) return [];
  return tx
    .select()
    .from(joinRequests)
    .where(
      sql`(${inArray(joinRequests.personId, [...personIds])} OR ${joinRequests.requestedByPersonId} = ${personIds[0]})`,
    )
    .orderBy(sql`${joinRequests.status} = 'pending' DESC`, desc(joinRequests.createdAt))
    .limit(100);
}

// --- Invitations -----------------------------------------------------------

export async function insertInvitation(
  tx: Tx,
  values: typeof invitations.$inferInsert,
): Promise<InvitationRow> {
  const [row] = await tx.insert(invitations).values(values).returning();
  return row!;
}

export async function setInvitationTokenHash(tx: Tx, id: string, tokenHash: string): Promise<void> {
  await tx.update(invitations).set({ tokenHash }).where(eq(invitations.id, id));
}

export async function lockInvitation(tx: Tx, id: string): Promise<InvitationRow | null> {
  const [row] = await tx.select().from(invitations).where(eq(invitations.id, id)).for("update");
  return row ?? null;
}

export async function findInvitation(tx: Tx, id: string): Promise<InvitationRow | null> {
  const [row] = await tx.select().from(invitations).where(eq(invitations.id, id));
  return row ?? null;
}

export async function revokeInvitation(tx: Tx, id: string): Promise<void> {
  await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), isNull(invitations.revokedAt)));
}

export async function countInvitationUse(
  tx: Tx,
  id: string,
  personId: string,
  firstAcceptance: boolean,
): Promise<void> {
  await tx
    .update(invitations)
    .set({
      uses: sql`${invitations.uses} + 1`,
      ...(firstAcceptance ? { acceptedByPersonId: personId, acceptedAt: new Date() } : {}),
    })
    .where(eq(invitations.id, id));
}

/** A page of the club's invitations, newest first (invitations_club_idx). */
export async function clubInvitationsPage(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number },
): Promise<{ items: InvitationRow[]; cursorFound: boolean }> {
  let after: { createdAt: Date; id: string } | null = null;
  if (page.cursor) {
    const [row] = await tx
      .select({ createdAt: invitations.createdAt, id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.id, page.cursor), eq(invitations.clubId, clubId)));
    if (!row) return { items: [], cursorFound: false };
    after = row;
  }
  const items = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.clubId, clubId),
        after
          ? sql`(${invitations.createdAt}, ${invitations.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(page.limit);
  return { items, cursorFound: true };
}

export interface FoundInvitation {
  invitationId: string;
  clubId: string;
  clubName: string;
  kind: "email" | "link" | "code";
  email: string | null;
}

/** A usable invitation by the hash of its token or code (app.find_club_invitation). */
export async function findUsableInvitation(
  tx: Tx,
  tokenHash: string,
): Promise<FoundInvitation | null> {
  const { rows } = await tx.execute<{
    invitation_id: string;
    club_id: string;
    club_name: string;
    kind: "email" | "link" | "code";
    email: string | null;
  }>(sql`SELECT * FROM app.find_club_invitation(${tokenHash})`);
  const row = rows[0];
  return row
    ? {
        invitationId: row.invitation_id,
        clubId: row.club_id,
        clubName: row.club_name,
        kind: row.kind,
        email: row.email,
      }
    : null;
}

/** Records the acceptance; false when the person accepted this invitation before. */
export async function insertAcceptance(
  tx: Tx,
  values: { clubId: string; invitationId: string; personId: string },
): Promise<boolean> {
  const rows = await tx
    .insert(invitationAcceptances)
    .values(values)
    .onConflictDoNothing({
      target: [invitationAcceptances.invitationId, invitationAcceptances.personId],
    })
    .returning({ id: invitationAcceptances.id });
  return rows.length > 0;
}
