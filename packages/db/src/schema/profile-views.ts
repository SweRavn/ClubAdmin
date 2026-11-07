// SPDX-License-Identifier: AGPL-3.0-only
// The profile view log (P1.12, ADR 0022): who opened whose profile, per club,
// viewer, viewed person and day, with a count. Rows with a club are the
// club's (tenant RLS); rows without a club (a guardian opening a ward from
// the family page) are written and read only through app.record_profile_view
// and app.profile_view_log. Anonymised when someone leaves the club
// (privacy.anonymize_profile_views, replayed after restores from the
// anonymisation ledger). No record history: the table is itself a log.

import {
  PROFILE_VIEW_SURFACES,
  PROFILE_VIEWER_KINDS,
  type ProfileViewerKind,
  type ProfileViewSurface,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { clubs } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";
import { people } from "./people.ts";

export const profileViews = pgTable(
  "profile_views",
  {
    id: id(),
    /** Null: a view outside any club (only protected people are logged then). */
    clubId: uuid().references(() => clubs.id),
    /** Null once anonymised. */
    viewedPersonId: uuid().references(() => people.id),
    viewerPersonId: uuid().references(() => people.id),
    onBehalfOfPersonId: uuid().references(() => people.id),
    viewerKind: text().$type<ProfileViewerKind>().notNull(),
    surface: text().$type<ProfileViewSurface>().notNull(),
    /** The viewed person was protected at the view. */
    protected: boolean().notNull(),
    /** In the club's time zone (UTC without a club). */
    day: date({ mode: "string" }).notNull(),
    firstViewedAt: timestamp(tz).notNull(),
    lastViewedAt: timestamp(tz).notNull(),
    viewCount: integer().notNull().default(1),
    anonymizedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    check("profile_views_viewer_kind", oneOf(t.viewerKind, PROFILE_VIEWER_KINDS)),
    check("profile_views_surface", oneOf(t.surface, PROFILE_VIEW_SURFACES)),
    check("profile_views_count", sql`${t.viewCount} > 0`),
    // One row per club, viewer, viewed person, surface and day while named.
    uniqueIndex("profile_views_key")
      .on(t.clubId, t.viewerPersonId, t.viewedPersonId, t.surface, t.day)
      .where(sql`${t.anonymizedAt} IS NULL`),
    index("profile_views_club_idx").on(t.clubId, t.lastViewedAt.desc(), t.id.desc()),
    index("profile_views_viewed_idx").on(t.viewedPersonId, t.lastViewedAt.desc(), t.id.desc()),
    index("profile_views_viewer_idx").on(t.viewerPersonId),
    index("profile_views_club_viewed_idx").on(t.clubId, t.viewedPersonId),
    index("profile_views_retention_idx").on(t.lastViewedAt),
  ],
);
