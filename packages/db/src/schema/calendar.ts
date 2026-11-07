// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions (P1.11, ADR 0021, ADR 0044): personal, secret,
// revocable iCalendar feed URLs. A global table owned by a person; the feed
// lookup (app.find_calendar_feed) is the only other way in.

import {
  CALENDAR_FEED_REVOKED_REASONS,
  CALENDAR_FEED_SCOPES,
  type CalendarFeedRevokedReason,
  type CalendarFeedScope,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { clubs, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";

export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: id(),
    /** The owner: the feed shows what they may see, with their current rights. */
    personId: personRef(),
    scope: text().$type<CalendarFeedScope>().notNull(),
    clubId: uuid().references(() => clubs.id),
    groupId: uuid(),
    /** `my_schedule`: whose activities (the owner and chosen wards); empty: everyone the owner may see. */
    personIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    label: text(),
    /** sha256 of the secret in the URL; the secret is shown once. */
    tokenHash: text().notNull(),
    lastFetchedAt: timestamp(tz),
    /** Since when a group or club feed has had no access (revoked after 30 days of that). */
    accessLostAt: timestamp(tz),
    revokedAt: timestamp(tz),
    revokedReason: text().$type<CalendarFeedRevokedReason>(),
    ...timestamps,
  },
  (t) => [
    unique("calendar_feeds_token_unique").on(t.tokenHash),
    foreignKey({
      name: "calendar_feeds_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
    check("calendar_feeds_scope", oneOf(t.scope, CALENDAR_FEED_SCOPES)),
    check(
      "calendar_feeds_scope_target",
      sql`(${t.scope} = 'my_schedule' AND ${t.clubId} IS NULL AND ${t.groupId} IS NULL)
        OR (${t.scope} = 'group' AND ${t.clubId} IS NOT NULL AND ${t.groupId} IS NOT NULL)
        OR (${t.scope} = 'club' AND ${t.clubId} IS NOT NULL AND ${t.groupId} IS NULL)`,
    ),
    check(
      "calendar_feeds_revoked_reason",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL) AND (${t.revokedReason} IS NULL OR ${oneOf(t.revokedReason, CALENDAR_FEED_REVOKED_REASONS)})`,
    ),
    check("calendar_feeds_label", sql`${t.label} IS NULL OR char_length(${t.label}) <= 60`),
    index("calendar_feeds_person_idx")
      .on(t.personId)
      .where(sql`${t.revokedAt} IS NULL`),
    // calendar:retention: revoked feeds, and open ones by last use.
    index("calendar_feeds_revoked_idx")
      .on(t.revokedAt)
      .where(sql`${t.revokedAt} IS NOT NULL`),
    index("calendar_feeds_unused_idx")
      .on(sql`(coalesce(${t.lastFetchedAt}, ${t.createdAt}))`)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
