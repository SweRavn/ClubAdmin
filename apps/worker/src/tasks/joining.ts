// SPDX-License-Identifier: AGPL-3.0-only
// Retention of joining data (docs/gdpr.md, P1.1): decided join requests and
// invitations that can no longer be used are deleted 12 months after their
// last change, club by club (the tables are under tenant row-level security).
// Record history keeps its own retention (ADR 0017).

import { type Database, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

const JOB = "joining:retention";

export async function deleteExpiredJoiningData(
  db: Database,
  months = 12,
): Promise<{ joinRequests: number; invitations: number }> {
  const { rows: clubs } = await db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM public.clubs`),
  );
  const deleted = { joinRequests: 0, invitations: 0 };
  for (const { id: clubId } of clubs) {
    await db.withSystem(JOB, { clubId }, async (tx) => {
      const cutoff = sql`now() - make_interval(months => ${months})`;
      const requests = await tx.execute(sql`
        DELETE FROM public.join_requests
        WHERE club_id = ${clubId} AND status <> 'pending' AND updated_at < ${cutoff}`);
      const gone = sql`
        SELECT id FROM public.invitations
        WHERE club_id = ${clubId} AND updated_at < ${cutoff}
          AND (revoked_at IS NOT NULL OR expires_at <= now() OR (max_uses IS NOT NULL AND uses >= max_uses))`;
      await tx.execute(sql`
        DELETE FROM public.invitation_acceptances
        WHERE club_id = ${clubId} AND invitation_id IN (${gone})`);
      const invitations = await tx.execute(sql`
        DELETE FROM public.invitations WHERE id IN (${gone})`);
      deleted.joinRequests += requests.rowCount ?? 0;
      deleted.invitations += invitations.rowCount ?? 0;
    });
  }
  return deleted;
}

export function joiningRetentionTask(db: Database): Task {
  return async (_payload, helpers) => {
    const deleted = await deleteExpiredJoiningData(db);
    helpers.logger.info("joining retention", deleted);
  };
}
