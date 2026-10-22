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

/**
 * Names outside a club (family emails, P1.3): the display name and the given
 * name, or null for a person with global protected identity, for recipients
 * who are not (yet) family of them, such as an invitee.
 */
export async function unprotectedNames(
  tx: Tx,
  personId: string,
): Promise<{ name: string; first: string } | null> {
  const { rows } = await tx.execute<{ name: string; given: string; protected: boolean }>(sql`
    SELECT given_name || ' ' || family_name AS name, given_name AS given, protected_identity AS protected
    FROM public.people WHERE id = ${personId}`);
  const row = rows[0];
  return row && !row.protected ? { name: row.name, first: row.given } : null;
}

/** The given name, for the person's own emails (an own-login invitation). */
export async function givenNameFor(tx: Tx, personId: string): Promise<string> {
  const { rows } = await tx.execute<{ given: string }>(
    sql`SELECT given_name AS given FROM public.people WHERE id = ${personId}`,
  );
  return rows[0]?.given ?? "";
}
