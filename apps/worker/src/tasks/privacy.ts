// SPDX-License-Identifier: AGPL-3.0-only
// Privacy jobs (P1.8a, ADR 0041). They run as clubadmin_retention (the
// worker's retention handle, DATABASE_RETENTION_URL): its policies see every
// club, and only it may call the privacy.* functions or delete audit events.
// One transaction per step; payloads and logs carry IDs and counts only.
//
// - privacy:retention (daily): former members past their club's
//   former_member_retention_months are purged (privacy.purge_former_member);
//   people without a login and without any relationship are marked orphaned,
//   and erased after ORPHAN_RETENTION_MONTHS (privacy.erase_person).
// - privacy:purge_member: "remove my contact details now" when leaving.
// - audit:retention (daily): audit events older than AUDIT_RETENTION_MONTHS.
// - clubs:apply_decisions (daily): board decisions whose effective date came.
// - privacy:protection_changed: a protected person's photo, video, streaming
//   and contact consents end (outbox, person.protection.changed).

import { audit, type Database, outbox, type OutboxHandler, sql } from "@clubadmin/db";
import {
  CLUB_SETTINGS,
  type ClubSettingKey,
  DOMAIN_EVENTS,
  PRIVACY_POLICY_TEMPLATE_VERSION,
  PROTECTED_INAPPLICABLE_PURPOSES,
  z,
} from "@clubadmin/shared";
import type { Task } from "graphile-worker";

const BATCH = 500;

export interface PrivacyJobOptions {
  /** The retention handle; without it the jobs log an error and do nothing. */
  retentionDb: Database | null;
  orphanRetentionMonths: number;
  auditRetentionMonths: number;
}

function requireRetention(
  options: PrivacyJobOptions,
  logger: { error: (message: string) => void },
): Database | null {
  if (!options.retentionDb) {
    logger.error("DATABASE_RETENTION_URL is not set: privacy jobs do nothing");
  }
  return options.retentionDb;
}

/** Purges one person's club data and marks or clears them as orphaned. */
async function purgeOne(db: Database, clubId: string, personId: string, now: boolean) {
  const purged = await db.withSystem("privacy:retention", { clubId }, async (tx) => {
    const { rows } = await tx.execute<{ purged: boolean }>(
      sql`SELECT privacy.purge_former_member(${clubId}, ${personId}, ${now}) AS purged`,
    );
    return rows[0]?.purged === true;
  });
  if (purged) {
    await db.withSystem("privacy:retention", {}, (tx) =>
      tx.execute(sql`SELECT privacy.mark_orphan(${personId})`),
    );
  }
  return purged;
}

export async function runPrivacyRetention(
  db: Database,
  options: { orphanRetentionMonths: number },
): Promise<{ purged: number; erased: number }> {
  let purged = 0;
  const { rows: clubs } = await db.withSystem("privacy:retention", {}, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM public.clubs ORDER BY id`),
  );
  for (const { id: clubId } of clubs) {
    for (;;) {
      // Former members past the club's period whose data was not purged since they left
      // (club_memberships_left_idx).
      const { rows } = await db.withSystem("privacy:retention", { clubId }, (tx) =>
        tx.execute<{ person_id: string }>(sql`
          SELECT DISTINCT m.person_id
          FROM public.club_memberships m
          JOIN public.clubs c ON c.id = m.club_id
          JOIN public.club_profiles p ON p.club_id = m.club_id AND p.person_id = m.person_id
          WHERE m.club_id = ${clubId} AND m.status = 'left'
            AND m.valid_to < now() - make_interval(months => c.former_member_retention_months)
            AND (p.club_data_purged_at IS NULL OR p.club_data_purged_at < m.valid_to)
            AND NOT EXISTS (SELECT 1 FROM public.club_memberships o
                            WHERE o.club_id = m.club_id AND o.person_id = m.person_id
                              AND o.valid_to IS NULL)
          LIMIT ${BATCH}`),
      );
      let done = 0;
      for (const { person_id: personId } of rows) {
        if (await purgeOne(db, clubId, personId, false)) done++;
      }
      purged += done;
      // Rows that could not be purged (an open relationship) stay out of the next batch only if purged.
      if (rows.length < BATCH || done === 0) break;
    }
  }

  let erased = 0;
  for (;;) {
    const { rows } = await db.withSystem("privacy:retention", {}, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM public.people
        WHERE orphaned_since < now() - make_interval(months => ${options.orphanRetentionMonths})
        ORDER BY orphaned_since LIMIT ${BATCH}`),
    );
    for (const { id } of rows) {
      await db.withSystem("privacy:retention", {}, async (tx) => {
        // A relationship that appeared since clears the mark instead.
        const { rows: check } = await tx.execute<{ orphan: boolean }>(
          sql`SELECT privacy.is_orphan(${id}) AS orphan`,
        );
        if (check[0]?.orphan) {
          await tx.execute(sql`SELECT privacy.erase_person(${id}, 'retention')`);
          erased++;
        } else {
          await tx.execute(sql`SELECT privacy.mark_orphan(${id})`);
        }
      });
    }
    if (rows.length < BATCH) break;
  }
  return { purged, erased };
}

export function privacyRetentionTask(options: PrivacyJobOptions): Task {
  return async (_payload, helpers) => {
    const db = requireRetention(options, helpers.logger);
    if (!db) return;
    const result = await runPrivacyRetention(db, options);
    helpers.logger.info("privacy retention", result);
  };
}

const PurgePayload = z.object({ clubId: z.uuid(), personId: z.uuid() });

export function purgeMemberTask(options: PrivacyJobOptions): Task {
  return async (payload, helpers) => {
    const db = requireRetention(options, helpers.logger);
    if (!db) throw new Error("DATABASE_RETENTION_URL is not set");
    const { clubId, personId } = PurgePayload.parse(payload);
    const purged = await purgeOne(db, clubId, personId, true);
    helpers.logger.info("club data purged on request", { clubId, purged });
  };
}

export async function runAuditRetention(db: Database, months: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.withSystem("audit:retention", {}, (tx) =>
      tx.execute(sql`
        DELETE FROM audit.events WHERE id IN (
          SELECT id FROM audit.events
          WHERE created_at < now() - make_interval(months => ${months})
          ORDER BY created_at LIMIT 10000)`),
    );
    deleted += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 10_000) return deleted;
  }
}

export function auditRetentionTask(options: PrivacyJobOptions): Task {
  return async (_payload, helpers) => {
    const db = requireRetention(options, helpers.logger);
    if (!db) return;
    const deleted = await runAuditRetention(db, options.auditRetentionMonths);
    helpers.logger.info("audit retention", { deleted });
  };
}

/**
 * Applies board decisions whose effective date has come (in the club's
 * time zone), as the API does for those in effect when recorded.
 */
export async function applyDueDecisions(db: Database, retentionDb: Database): Promise<number> {
  // Listed across clubs with the retention handle (it sees every club), applied in each club.
  const { rows } = await retentionDb.withSystem("clubs:apply_decisions", {}, (tx) =>
    tx.execute<{ id: string; club_id: string }>(sql`
      SELECT d.id, d.club_id FROM public.club_setting_decisions d
      JOIN public.clubs c ON c.id = d.club_id
      WHERE d.applied_at IS NULL AND d.effective_from <= (now() AT TIME ZONE c.time_zone)::date
      ORDER BY d.effective_from, d.id LIMIT 1000`),
  );
  let applied = 0;
  for (const { id, club_id: clubId } of rows) {
    await db.withSystem("clubs:apply_decisions", { clubId }, async (tx) => {
      const { rows: result } = await tx.execute<{ policy_id: string | null }>(
        sql`SELECT app.apply_setting_decision(${id}, ${PRIVACY_POLICY_TEMPLATE_VERSION}) AS policy_id`,
      );
      const policyId = result[0]?.policy_id;
      if (!policyId) return;
      const { rows: decision } = await tx.execute<{ settings: Record<string, unknown> }>(
        sql`SELECT settings FROM public.club_setting_decisions WHERE id = ${id}`,
      );
      await audit.record(tx, {
        action: "club.settings.updated",
        resourceType: "club",
        resourceId: clubId,
        changedFields: Object.keys(decision[0]?.settings ?? {}).map(
          (key) => CLUB_SETTINGS[key as ClubSettingKey]?.field ?? key,
        ),
      });
      await audit.record(tx, {
        action: "club.privacy_policy.published",
        resourceType: "club_privacy_policy",
        resourceId: policyId,
      });
      await outbox.publish(tx, "club.privacy_policy.published", { clubId, policyId });
      applied++;
    });
  }
  return applied;
}

export function applyDecisionsTask(db: Database, options: PrivacyJobOptions): Task {
  return async (_payload, helpers) => {
    const retentionDb = requireRetention(options, helpers.logger);
    if (!retentionDb) return;
    const applied = await applyDueDecisions(db, retentionDb);
    helpers.logger.info("board decisions applied", { applied });
  };
}

/**
 * Ends the consents a protected person cannot have (P1.8a, ADR 0022): photo,
 * video, streaming and contact purposes; in every club for the global flag,
 * in one club for the club's flag.
 */
export async function revokeInapplicableConsents(
  db: Database,
  personId: string,
  clubId: string | null,
): Promise<number> {
  return db.withSystem("privacy:protection_changed", {}, async (tx) => {
    const { rows } = await tx.execute<{ id: string; club_id: string; purpose: string }>(sql`
      UPDATE public.consents k SET revoked_at = now(), revoked_reason = 'not_applicable'
      FROM public.people p
      LEFT JOIN public.club_profiles cp ON cp.person_id = p.id
      WHERE p.id = ${personId} AND k.person_id = p.id AND k.revoked_at IS NULL
        AND (cp.club_id IS NULL OR cp.club_id = k.club_id)
        AND (${clubId}::uuid IS NULL OR k.club_id = ${clubId}::uuid)
        AND k.purpose = ANY (${`{${PROTECTED_INAPPLICABLE_PURPOSES.join(",")}}`}::text[])
        AND (p.protected_identity OR coalesce(cp.protected_identity_club, false))
      RETURNING k.id, k.club_id, k.purpose`);
    // Audited; no consent.changed event (the retention role has no outbox, and
    // nothing consumes it yet: photo and streaming modules check the flag too).
    for (const r of rows) {
      await audit.record(tx, {
        action: "consent.withdrawn",
        resourceType: "consent",
        resourceId: r.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
    }
    return rows.length;
  });
}

const ProtectionPayload = z.object({ personId: z.uuid(), clubId: z.uuid().optional() });

export function protectionChangedTask(options: PrivacyJobOptions): Task {
  return async (payload, helpers) => {
    const db = requireRetention(options, helpers.logger);
    if (!db) throw new Error("DATABASE_RETENTION_URL is not set");
    const { personId, clubId } = ProtectionPayload.parse(payload);
    const revoked = await revokeInapplicableConsents(db, personId, clubId ?? null);
    helpers.logger.info("consents of a protected person ended", { revoked });
  };
}

/**
 * The outbox handler of the privacy jobs: a protection change queues
 * privacy:protection_changed (run with the retention handle, outside the
 * handler's transaction).
 */
export function privacyHandler(): OutboxHandler {
  return {
    name: "privacy",
    types: ["person.protection.changed"],
    async handle(event, tx) {
      const { personId, clubId } = DOMAIN_EVENTS["person.protection.changed"].parse(event.payload);
      await tx.execute(sql`
        SELECT graphile_worker.add_job('privacy:protection_changed',
          ${JSON.stringify({ personId, ...(clubId ? { clubId } : {}) })}::json,
          job_key := ${`privacy:protection:${personId}:${clubId ?? "all"}`}, max_attempts := 10)`);
    },
  };
}
