// SPDX-License-Identifier: AGPL-3.0-only
// Guardianships whose ward has reached the adult age are flagged, never ended
// automatically: the young person decides which guardian access continues
// (domain-model.md). Each flag is audited and publishes an event for the
// notifications (P1.7).
//
// The job runs without a club, so it cannot see which clubs (countries) a
// ward belongs to; it uses the highest adultAge of all country packs, so no
// guardianship is flagged too early.

import { COUNTRY_PACKS } from "@clubadmin/country-packs";
import { audit, type Database, outbox, sql } from "@clubadmin/db";
import type { Task } from "graphile-worker";

export const ADULT_AGE = Math.max(...Object.values(COUNTRY_PACKS).map((p) => p.ageRules.adultAge));

export async function flagAdultWards(db: Database, today?: string): Promise<number> {
  return db.withSystem("guardianships:flag_adult_wards", {}, async (tx) => {
    const { rows } = await tx.execute<{ id: string; ward_person_id: string }>(sql`
      UPDATE guardianships AS g SET ward_adult_flagged_at = now()
      FROM people AS p
      WHERE p.id = g.ward_person_id
        AND g.status = 'active' AND g.valid_to IS NULL AND g.ward_adult_flagged_at IS NULL
        AND p.birth_date <= coalesce(${today ?? null}::date, current_date) - make_interval(years => ${ADULT_AGE})
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

export function flagAdultWardsTask(db: Database): Task {
  return async (_payload, helpers) => {
    const flagged = await flagAdultWards(db);
    if (flagged > 0)
      helpers.logger.info("guardianships flagged: ward reached adult age", { flagged });
  };
}
