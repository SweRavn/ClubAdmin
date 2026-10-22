// SPDX-License-Identifier: AGPL-3.0-only
// Age transitions of wards (domain-model.md, P1.3), daily:
// - at the adult age, guardianships are flagged, never ended automatically:
//   the young person decides which guardian access continues. Each flag is
//   audited and publishes an event (email to the young person, or to the
//   guardians when the young person has no login);
// - at the own-login age, each full guardian of a ward without a login is
//   told once that "Give own login" is now possible.
//
// The ages come from the country packs of the ward's clubs (the strictest
// when several; the deployment's default country without clubs, issue #6).

import { COUNTRY_PACKS, getCountryPack } from "@clubadmin/country-packs";
import { audit, type Database, outbox, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

/** The country packs' ages as a SQL VALUES list (country, adult_age, own_age). */
function packs() {
  return sql.join(
    Object.entries(COUNTRY_PACKS).map(
      ([country, pack]) =>
        sql`(${country}::text, ${pack.ageRules.adultAge}::int, ${pack.ageRules.ownAccountMinAge}::int)`,
    ),
    sql`, `,
  );
}

/** A ward's age rule from their clubs' packs (club_memberships system_read, migration 0009). */
const wardAge = (column: "adult_age" | "own_age", fallback: number) => sql`
  coalesce((
    SELECT max(pk.${sql.raw(column)}) FROM public.club_memberships m
    JOIN public.clubs c ON c.id = m.club_id
    JOIN packs pk ON pk.country = c.country
    WHERE m.person_id = p.id AND m.valid_to IS NULL
  ), ${fallback}::int)`;

export interface AgeOptions {
  /** DEFAULT_COUNTRY: the rules for wards without clubs. */
  defaultCountry: string;
  /** For tests: the day the job runs (ISO date). */
  today?: string;
}

export async function flagAdultWards(db: Database, options: AgeOptions): Promise<number> {
  const fallback = getCountryPack(options.defaultCountry).ageRules.adultAge;
  return db.withSystem("guardianships:flag_adult_wards", {}, async (tx) => {
    const { rows } = await tx.execute<{ id: string; ward_person_id: string }>(sql`
      WITH packs (country, adult_age, own_age) AS (VALUES ${packs()}),
      due AS (
        SELECT g.id FROM public.guardianships g
        JOIN public.people p ON p.id = g.ward_person_id
        WHERE g.status = 'active' AND g.valid_to IS NULL AND g.ward_adult_flagged_at IS NULL
          AND p.birth_date IS NOT NULL
          AND p.birth_date <= coalesce(${options.today ?? null}::date, current_date)
            - make_interval(years => ${wardAge("adult_age", fallback)})
      )
      UPDATE public.guardianships AS g SET ward_adult_flagged_at = now()
      FROM due WHERE g.id = due.id
      RETURNING g.id, g.ward_person_id`);
    for (const row of rows) {
      await audit.record(tx, {
        action: "guardianship.ward.adult",
        resourceType: "guardianship",
        resourceId: row.id,
        changedFields: ["ward_adult_flagged_at"],
      });
      await outbox.publish(tx, "guardianship.ward.adult", {
        guardianshipId: row.id,
        wardPersonId: row.ward_person_id,
      });
    }
    return rows.length;
  });
}

/**
 * Full guardians of wards who reached the own-login age within the last year
 * and have no login: told once each (own_login_age_notified_at).
 */
export async function notifyOwnLoginAge(db: Database, options: AgeOptions): Promise<number> {
  const fallback = getCountryPack(options.defaultCountry).ageRules.ownAccountMinAge;
  return db.withSystem("guardianships:own_login_age", {}, async (tx) => {
    const today = sql`coalesce(${options.today ?? null}::date, current_date)`;
    const { rows } = await tx.execute<{ id: string; ward_person_id: string }>(sql`
      WITH packs (country, adult_age, own_age) AS (VALUES ${packs()}),
      wards AS (
        SELECT p.id, p.birth_date, ${wardAge("own_age", fallback)} AS own_age
        FROM public.people p
        WHERE p.id IN (
          SELECT g.ward_person_id FROM public.guardianships g
          WHERE g.status = 'active' AND g.valid_to IS NULL AND g.own_login_age_notified_at IS NULL
            AND g.kind IN ('parent', 'legal_guardian')
        )
          AND p.birth_date IS NOT NULL AND p.anonymized_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = p.id)
      ), due AS (
        SELECT g.id FROM public.guardianships g JOIN wards w ON w.id = g.ward_person_id
        WHERE g.status = 'active' AND g.valid_to IS NULL AND g.own_login_age_notified_at IS NULL
          AND g.kind IN ('parent', 'legal_guardian')
          AND w.birth_date <= ${today} - make_interval(years => w.own_age)
          AND w.birth_date > ${today} - make_interval(years => w.own_age + 1)
      )
      UPDATE public.guardianships AS g SET own_login_age_notified_at = now()
      FROM due WHERE g.id = due.id
      RETURNING g.id, g.ward_person_id`);
    for (const row of rows) {
      await outbox.publish(tx, "guardianship.ward.own_login_age", {
        guardianshipId: row.id,
        wardPersonId: row.ward_person_id,
      });
    }
    return rows.length;
  });
}

export function flagAdultWardsTask(db: Database, options: AgeOptions): Task {
  return async (_payload, helpers) => {
    const flagged = await flagAdultWards(db, options);
    if (flagged > 0)
      helpers.logger.info("guardianships flagged: ward reached adult age", { flagged });
    const told = await notifyOwnLoginAge(db, options);
    if (told > 0) helpers.logger.info("guardians told: ward reached own-login age", { told });
  };
}
