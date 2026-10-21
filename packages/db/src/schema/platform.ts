// SPDX-License-Identifier: AGPL-3.0-only
// Platform operators and the time-limited support access clubs grant them
// (docs/domain-model.md, "Platform tables"). Operators have no access to club
// data without a grant (ADR 0006, ADR 0023).

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { clubRef, personRef } from "./clubs.ts";
import { id, timestamps, tz, validity, validPeriod } from "./columns.ts";
import { people } from "./people.ts";

/** People who operate the hosted platform. Written only by operator tooling. */
export const platformOperators = pgTable(
  "platform_operators",
  {
    id: id(),
    personId: personRef(),
    ...validity,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("platform_operators_open_unique")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
    check("platform_operators_valid_period", validPeriod(t.validFrom, t.validTo)),
  ],
);

/** Support access a club manager granted to an operator, until it expires or is revoked. */
export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: id(),
    clubId: clubRef(),
    operatorPersonId: personRef(),
    grantedByPersonId: uuid()
      .notNull()
      .references(() => people.id),
    /** Why support needs access (shown to club managers). */
    reason: text().notNull(),
    expiresAt: timestamp(tz).notNull(),
    revokedAt: timestamp(tz),
    revokedByPersonId: uuid().references(() => people.id),
    ...timestamps,
  },
  (t) => [
    index("support_access_grants_operator_idx")
      .on(t.operatorPersonId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("support_access_grants_club_idx").on(t.clubId, t.expiresAt),
    check("support_access_grants_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
