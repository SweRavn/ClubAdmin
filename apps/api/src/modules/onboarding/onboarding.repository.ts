// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, schema, sql, type Tx } from "@clubadmin/db";
import type { ClubCreationRequestStatus } from "@clubadmin/shared";

const { clubCreationRequests: requests } = schema;

export type CreationRequestRow = typeof requests.$inferSelect;

export async function insertRequest(
  tx: Tx,
  values: typeof requests.$inferInsert,
): Promise<CreationRequestRow> {
  const [row] = await tx.insert(requests).values(values).returning();
  return row!;
}

export async function lockRequest(tx: Tx, id: string): Promise<CreationRequestRow | null> {
  const [row] = await tx.select().from(requests).where(eq(requests.id, id)).for("update");
  return row ?? null;
}

export async function decideRequest(
  tx: Tx,
  id: string,
  values: Pick<
    typeof requests.$inferInsert,
    "status" | "decidedByPersonId" | "decisionMessage" | "createdClubId"
  >,
): Promise<void> {
  await tx
    .update(requests)
    .set({ ...values, decidedAt: new Date() })
    .where(eq(requests.id, id));
}

export async function requestsOf(tx: Tx, personId: string): Promise<CreationRequestRow[]> {
  return tx
    .select()
    .from(requests)
    .where(eq(requests.requestedByPersonId, personId))
    .orderBy(desc(requests.createdAt))
    .limit(20);
}

/** Operators' queue: oldest first (club_creation_requests_status_idx). */
export async function requestsPage(
  tx: Tx,
  status: ClubCreationRequestStatus,
  page: { cursor: string | null; limit: number },
): Promise<{ items: CreationRequestRow[]; cursorFound: boolean }> {
  let after: { createdAt: Date; id: string } | null = null;
  if (page.cursor) {
    const [row] = await tx
      .select({ createdAt: requests.createdAt, id: requests.id })
      .from(requests)
      .where(eq(requests.id, page.cursor));
    if (!row) return { items: [], cursorFound: false };
    after = row;
  }
  const items = await tx
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.status, status),
        after
          ? sql`(${requests.createdAt}, ${requests.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(requests.createdAt), asc(requests.id))
    .limit(page.limit);
  return { items, cursorFound: true };
}
