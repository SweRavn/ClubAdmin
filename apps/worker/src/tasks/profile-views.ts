// SPDX-License-Identifier: AGPL-3.0-only
// The profile view log (P1.12, ADR 0022, docs/gdpr.md):
// - privacy:anonymize_profile_views (enqueued when a membership, role or
//   assignment changes): when a person no longer has any relationship to a
//   club (privacy.has_club_relationship), the club's log stops naming them,
//   as viewer or as viewed person, and the anonymisation ledger records it so
//   a restore from backup applies it again.
// - privacy:profile_views (daily): the same check for everyone the club's
//   log still names (catch-up, e.g. after a guardianship ended), rows 24
//   months after their last view deleted, ledger entries after 13 months.

import { type Database, type OutboxHandler, sql } from "@clubadmin/db";
import { z } from "@clubadmin/shared";
import type { Task } from "graphile-worker";

const JOB = "privacy:profile_views";

/** Anonymises the person in the club's log if they have left; rows changed. */
export async function anonymizeIfLeft(
  db: Database,
  clubId: string,
  personId: string,
): Promise<number> {
  return db.withSystem("privacy:anonymize_profile_views", { clubId }, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`
      SELECT CASE WHEN privacy.has_club_relationship(${personId}, ${clubId}) THEN 0
        ELSE privacy.anonymize_profile_views(${personId}, ${clubId}, true) END AS n`);
    return rows[0]?.n ?? 0;
  });
}

export interface ProfileViewsResult {
  anonymized: number;
  deleted: number;
  ledgerDeleted: number;
}

export async function runProfileViewsRetention(
  db: Database,
  options: { months?: number; ledgerMonths?: number } = {},
): Promise<ProfileViewsResult> {
  const months = options.months ?? 24;
  const ledgerMonths = options.ledgerMonths ?? 13;
  const result: ProfileViewsResult = { anonymized: 0, deleted: 0, ledgerDeleted: 0 };
  const { rows: clubs } = await db.withSystem(JOB, {}, (tx) =>
    tx.execute<{ club_id: string }>(sql`
      SELECT DISTINCT club_id FROM public.profile_views WHERE club_id IS NOT NULL`),
  );
  for (const { club_id: clubId } of clubs) {
    await db.withSystem(JOB, { clubId }, async (tx) => {
      const { rows } = await tx.execute<{ n: number }>(sql`
        WITH named AS (
          SELECT viewed_person_id AS p FROM public.profile_views
          WHERE club_id = ${clubId} AND viewed_person_id IS NOT NULL
          UNION SELECT viewer_person_id FROM public.profile_views
          WHERE club_id = ${clubId} AND viewer_person_id IS NOT NULL
          UNION SELECT on_behalf_of_person_id FROM public.profile_views
          WHERE club_id = ${clubId} AND on_behalf_of_person_id IS NOT NULL)
        SELECT coalesce(sum(privacy.anonymize_profile_views(p, ${clubId}, true)), 0)::int AS n
        FROM named WHERE NOT privacy.has_club_relationship(p, ${clubId})`);
      result.anonymized += rows[0]?.n ?? 0;
    });
  }
  await db.withSystem(JOB, {}, async (tx) => {
    const deleted = await tx.execute(sql`
      DELETE FROM public.profile_views
      WHERE last_viewed_at < now() - make_interval(months => ${months})`);
    const ledger = await tx.execute(sql`
      DELETE FROM privacy.anonymization_ledger
      WHERE anonymized_at < now() - make_interval(months => ${ledgerMonths})`);
    result.deleted = deleted.rowCount ?? 0;
    result.ledgerDeleted = ledger.rowCount ?? 0;
  });
  return result;
}

const AnonymizePayload = z.object({ clubId: z.uuid(), personId: z.uuid() });

export function anonymizeProfileViewsTask(db: Database): Task {
  return async (payload, helpers) => {
    const { clubId, personId } = AnonymizePayload.parse(payload);
    const n = await anonymizeIfLeft(db, clubId, personId);
    if (n > 0) helpers.logger.info("profile views anonymised", { clubId, rows: n });
  };
}

export function profileViewsRetentionTask(db: Database): Task {
  return async (_payload, helpers) => {
    const result = await runProfileViewsRetention(db);
    if (result.anonymized || result.deleted || result.ledgerDeleted) {
      helpers.logger.info("profile views retention", { ...result });
    }
  };
}

/** Membership, role and assignment changes: check the person's place in the club's log. */
export function profileViewsHandler(): OutboxHandler {
  return {
    name: "profile-views",
    types: ["membership.changed", "membership.left", "role.changed", "assignment.ended"],
    async handle(event, tx) {
      const { clubId, personId } = z
        .object({ clubId: z.uuid(), personId: z.uuid() })
        .parse(event.payload);
      await tx.execute(sql`
        SELECT graphile_worker.add_job('privacy:anonymize_profile_views',
          ${JSON.stringify({ clubId, personId })}::json,
          job_key := ${`privacy:profile_views:${clubId}:${personId}`}, max_attempts := 10)`);
    },
  };
}
