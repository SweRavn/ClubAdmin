// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance (P1.5, ADR 0035): a member's answer to an activity
// (intent; given by the member or a guardian) and the leaders' attendance
// mark (fact). One row per activity and person in each; record history on
// both. The activity's groups and roster live in activities and
// group_memberships.

import {
  ATTENDANCE_ROLES,
  ATTENDANCE_STATUSES,
  type AttendanceRole,
  type AttendanceStatus,
  RESPONSE_STATUSES,
  type ResponseStatus,
} from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activities } from "./activities.ts";
import { clubRef, personRef } from "./clubs.ts";
import { id, oneOf, timestamps, tz } from "./columns.ts";

export const activityResponses = pgTable(
  "activity_responses",
  {
    id: id(),
    clubId: clubRef(),
    activityId: uuid().notNull(),
    /** Whose answer. */
    personId: personRef(),
    status: text().$type<ResponseStatus>().notNull(),
    /** To the leaders only; never in calendars, counts, exports, push or email. */
    note: text(),
    /** The person, or the guardian who answered for them. */
    respondedByPersonId: personRef(),
    respondedAt: timestamp(tz).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "activity_responses_activity_fk",
      columns: [t.clubId, t.activityId],
      foreignColumns: [activities.clubId, activities.id],
    }),
    check("activity_responses_status", oneOf(t.status, RESPONSE_STATUSES)),
    check("activity_responses_note", sql`${t.note} IS NULL OR length(${t.note}) <= 200`),
    unique("activity_responses_unique").on(t.activityId, t.personId),
    // Lists and counts of an activity; "My schedule" (a person's answers).
    index("activity_responses_activity_idx").on(t.clubId, t.activityId),
    index("activity_responses_person_idx").on(t.personId, t.activityId),
    index("activity_responses_responder_idx").on(t.respondedByPersonId),
  ],
);

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: id(),
    clubId: clubRef(),
    activityId: uuid().notNull(),
    personId: personRef(),
    status: text().$type<AttendanceStatus>().notNull(),
    role: text().$type<AttendanceRole>().notNull().default("participant"),
    /** Not a member of the activity's groups on its start. */
    guest: boolean().notNull().default(false),
    recordedByPersonId: personRef(),
    /** When the mark was taken on the device (offline outbox); the newer mark wins. */
    recordedAt: timestamp(tz).notNull().defaultNow(),
    /** Set on corrections after the lock (never personal data). */
    correctedReason: text(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "attendance_records_activity_fk",
      columns: [t.clubId, t.activityId],
      foreignColumns: [activities.clubId, activities.id],
    }),
    check("attendance_records_status", oneOf(t.status, ATTENDANCE_STATUSES)),
    check("attendance_records_role", oneOf(t.role, ATTENDANCE_ROLES)),
    unique("attendance_records_unique").on(t.activityId, t.personId),
    index("attendance_records_activity_idx").on(t.clubId, t.activityId),
    // A member's attendance over a period (group summaries).
    index("attendance_records_person_idx").on(t.clubId, t.personId, t.activityId),
    index("attendance_records_recorder_idx").on(t.recordedByPersonId),
  ],
);
