// SPDX-License-Identifier: AGPL-3.0-only
// Groups (ADR 0019): teams, training groups, sections, committees. Every
// reference to a group also carries club_id, and composite foreign keys
// guarantee both rows belong to the same club.

import {
  ADMISSION_MODES,
  type AdmissionMode,
  GENDER_CATEGORIES,
  type GenderCategory,
  GROUP_FUNCTIONS,
  GROUP_KINDS,
  type GroupFunction,
  type GroupKind,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { clubRef, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz, validity, validPeriod } from "./columns.ts";
import { people } from "./people.ts";

export const groups = pgTable(
  "groups",
  {
    id: id(),
    clubId: clubRef(),
    /** Optional hierarchy (section → team); same club, no cycles (trigger). */
    parentGroupId: uuid(),
    kind: text().$type<GroupKind>().notNull(),
    name: text().notNull(),
    sport: text(),
    birthYearFrom: smallint(),
    birthYearTo: smallint(),
    genderCategory: text().$type<GenderCategory>(),
    level: text(),
    capacity: integer(),
    admissionMode: text().$type<AdmissionMode>().notNull().default("direct"),
    waitlistVisiblePublicly: boolean().notNull().default(false),
    offerReplyDays: smallint().notNull().default(7),
    archivedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("groups_club_id_unique").on(t.clubId, t.id),
    foreignKey({
      name: "groups_parent_same_club_fk",
      columns: [t.clubId, t.parentGroupId],
      foreignColumns: [t.clubId, t.id],
    }),
    check("groups_kind", oneOf(t.kind, GROUP_KINDS)),
    check("groups_admission_mode", oneOf(t.admissionMode, ADMISSION_MODES)),
    check(
      "groups_gender_category",
      sql`${t.genderCategory} IS NULL OR ${oneOf(t.genderCategory, GENDER_CATEGORIES)}`,
    ),
    check("groups_not_own_parent", sql`${t.parentGroupId} <> ${t.id}`),
    check(
      "groups_birth_years",
      sql`${t.birthYearFrom} IS NULL OR ${t.birthYearTo} IS NULL OR ${t.birthYearTo} >= ${t.birthYearFrom}`,
    ),
    check("groups_capacity", sql`${t.capacity} IS NULL OR ${t.capacity} >= 0`),
    check("groups_offer_reply_days", sql`${t.offerReplyDays} BETWEEN 1 AND 60`),
    index("groups_club_idx")
      .on(t.clubId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    index("groups_parent_idx").on(t.clubId, t.parentGroupId),
  ],
);

/** Reference to a group of the same club (composite foreign key). */
const sameClubGroup = (t: { clubId: AnyPgColumn; groupId: AnyPgColumn }, name: string) =>
  foreignKey({ name, columns: [t.clubId, t.groupId], foreignColumns: [groups.clubId, groups.id] });

export const seasons = pgTable(
  "seasons",
  {
    id: id(),
    clubId: clubRef(),
    name: text().notNull(),
    startsOn: date({ mode: "string" }).notNull(),
    endsOn: date({ mode: "string" }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("seasons_club_id_unique").on(t.clubId, t.id),
    check("seasons_period", sql`${t.endsOn} > ${t.startsOn}`),
    index("seasons_club_idx").on(t.clubId, t.startsOn),
  ],
);

/** Per-season settings of a group (groups persist across seasons). */
export const groupSeasons = pgTable(
  "group_seasons",
  {
    id: id(),
    clubId: clubRef(),
    groupId: uuid().notNull(),
    seasonId: uuid().notNull(),
    capacity: integer(),
    notes: text(),
    ...timestamps,
  },
  (t) => [
    sameClubGroup(t, "group_seasons_group_fk"),
    foreignKey({
      name: "group_seasons_season_fk",
      columns: [t.clubId, t.seasonId],
      foreignColumns: [seasons.clubId, seasons.id],
    }),
    unique("group_seasons_unique").on(t.groupId, t.seasonId),
    check("group_seasons_capacity", sql`${t.capacity} IS NULL OR ${t.capacity} >= 0`),
  ],
);

/** Person ↔ group with a function; several functions are separate rows. */
export const groupMemberships = pgTable(
  "group_memberships",
  {
    id: id(),
    clubId: clubRef(),
    groupId: uuid().notNull(),
    personId: personRef(),
    function: text().$type<GroupFunction>().notNull().default("member"),
    ...validity,
    ...timestamps,
  },
  (t) => [
    sameClubGroup(t, "group_memberships_group_fk"),
    check("group_memberships_function", oneOf(t.function, GROUP_FUNCTIONS)),
    check("group_memberships_valid_period", validPeriod(t.validFrom, t.validTo)),
    uniqueIndex("group_memberships_open_unique")
      .on(t.groupId, t.personId, t.function)
      .where(sql`${t.validTo} IS NULL`),
    // Members of a group; my groups.
    index("group_memberships_group_idx")
      .on(t.clubId, t.groupId)
      .where(sql`${t.validTo} IS NULL`),
    // Who was in a group at a time (an activity's roster, P1.5).
    index("group_memberships_group_period_idx").on(t.groupId, t.validFrom),
    index("group_memberships_person_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

/** Administrative ownership of a group (ADR 0019); several or none per group. */
export const groupOwners = pgTable(
  "group_owners",
  {
    id: id(),
    clubId: clubRef(),
    groupId: uuid().notNull(),
    personId: personRef(),
    assignedByPersonId: uuid().references(() => people.id),
    ...validity,
    ...timestamps,
  },
  (t) => [
    sameClubGroup(t, "group_owners_group_fk"),
    check("group_owners_valid_period", validPeriod(t.validFrom, t.validTo)),
    uniqueIndex("group_owners_open_unique")
      .on(t.groupId, t.personId)
      .where(sql`${t.validTo} IS NULL`),
    index("group_owners_group_idx")
      .on(t.groupId)
      .where(sql`${t.validTo} IS NULL`),
    index("group_owners_person_idx")
      .on(t.personId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);
