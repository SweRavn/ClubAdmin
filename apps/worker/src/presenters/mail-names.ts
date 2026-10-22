// SPDX-License-Identifier: AGPL-3.0-only
// Person names in emails (CLAUDE.md rule 4, ADR 0022): the worker's
// counterpart of the API's PersonPresenter for the transactional emails.

import { sql, type Tx } from "@clubadmin/db";

/** A person's display name, or null if they are protected in the club (ADR 0022). */
export async function visibleName(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ name: string; protected: boolean }>(sql`
    SELECT p.given_name || ' ' || p.family_name AS name,
      p.protected_identity OR coalesce((
        SELECT cp.protected_identity_club FROM public.club_profiles cp
        WHERE cp.club_id = ${clubId} AND cp.person_id = p.id), false) AS protected
    FROM public.people p WHERE p.id = ${personId}`);
  const row = rows[0];
  return row && !row.protected ? row.name : null;
}

/** The name for recipients who may see the person (themselves, family, managers). */
export async function nameFor(tx: Tx, personId: string): Promise<string> {
  const { rows } = await tx.execute<{ name: string }>(
    sql`SELECT given_name || ' ' || family_name AS name FROM public.people WHERE id = ${personId}`,
  );
  return rows[0]?.name ?? "";
}
