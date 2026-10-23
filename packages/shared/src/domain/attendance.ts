// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance (P1.5, ADR 0035): whether a member is coming to an
// activity (intent, given by the member or a guardian) and whether they were
// there (fact, recorded by the leaders). People appear only as PersonSummary
// through the person presenter; protected members are counted, never named,
// for viewers who may not see them (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

/** Whether an activity asks for answers: not at all, optionally, or by a deadline. */
export const RESPONSE_MODES = ["none", "optional", "requested"] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

export const RESPONSE_STATUSES = ["attending", "not_attending"] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const ATTENDANCE_STATUSES = ["present", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Leaders count separately in grant reports. */
export const ATTENDANCE_ROLES = ["participant", "leader"] as const;
export type AttendanceRole = (typeof ATTENDANCE_ROLES)[number];

/** The response mode a new activity or series of this kind gets when none is given. */
export function defaultResponseMode(kind: string): ResponseMode {
  if (kind === "training") return "optional";
  if (kind === "match" || kind === "meeting") return "requested";
  return "none";
}

/** Days after the start during which leaders record attendance (club setting). */
export const DEFAULT_ATTENDANCE_LOCK_DAYS = 30;
/** Leaders may start taking attendance this long before the start. */
export const ATTENDANCE_OPENS_BEFORE_MINUTES = 60;
/** Offline writes: how old a device's recordedAt may be, and how far ahead of the server. */
export const OFFLINE_MAX_AGE_DAYS = 7;
export const CLOCK_SKEW_MINUTES = 5;
/** Marks in one request. */
export const ATTENDANCE_BATCH_MAX = 200;

const note = z.string().trim().min(1).max(200);

// --- Responses ---------------------------------------------------------------------

export const ResponseParamsSchema = z.object({ activityId: z.uuid(), personId: z.uuid() });

export const SetResponseSchema = z
  .object({
    status: z.enum(RESPONSE_STATUSES),
    /** To the leaders only ("fever"); never more than needed. */
    note: note.nullish(),
  })
  .strict()
  .openapi("SetResponseRequest");
export type SetResponseInput = z.input<typeof SetResponseSchema>;

/** Whose answer, as given: who answered (the person or a guardian) and when. */
export const ResponseSchema = z
  .object({
    person: PersonSummarySchema,
    status: z.enum(RESPONSE_STATUSES).nullable(),
    /** Only for the leaders and for the person and their guardians. */
    note: z.string().nullable().optional(),
    /** Null when not answered, or when the viewer may not see who answered. */
    respondedBy: PersonSummarySchema.nullable(),
    respondedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .openapi("ActivityResponse");
export type ActivityResponse = z.infer<typeof ResponseSchema>;

export const ResponseCountsSchema = z
  .object({
    attending: z.number().int(),
    notAttending: z.number().int(),
    notAnswered: z.number().int(),
    /** Members of the activity's groups on its start (protected ones included). */
    roster: z.number().int(),
  })
  .openapi("ResponseCounts");
export type ResponseCounts = z.infer<typeof ResponseCountsSchema>;

export const MyResponseSchema = ResponseSchema.extend({
  /** Whether the viewer may answer for this person now. */
  canRespond: z.boolean(),
}).openapi("MyActivityResponse");
export type MyResponse = z.infer<typeof MyResponseSchema>;

export const ResponseSummarySchema = z
  .object({
    activityId: z.uuid(),
    responseMode: z.enum(RESPONSE_MODES),
    respondBy: z.iso.datetime({ offset: true }).nullable(),
    /** Answers are accepted now (not cancelled, not over; after the deadline only "not attending"). */
    open: z.boolean(),
    deadlinePassed: z.boolean(),
    counts: ResponseCountsSchema,
    /**
     * Those attending whom the viewer may see, for viewers who may read the
     * group's members; null otherwise (counts only).
     */
    attending: z.array(PersonSummarySchema).nullable(),
    /** The viewer's own answer and their wards' (those on the roster). */
    mine: z.array(MyResponseSchema),
  })
  .openapi("ResponseSummary");
export type ResponseSummary = z.infer<typeof ResponseSummarySchema>;

export const ResponseListQuerySchema = z.object({
  /** `none`: not answered. */
  status: z.enum(["attending", "not_attending", "none"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ResponseListQuery = z.infer<typeof ResponseListQuerySchema>;

export const ResponseListSchema = z
  .object({
    items: z.array(ResponseSchema),
    nextCursor: z.uuid().nullable(),
    counts: ResponseCountsSchema,
  })
  .openapi("ResponseList");
export type ResponseList = z.infer<typeof ResponseListSchema>;

// --- Call-ups (#19, ADR 0036) --------------------------------------------------------

/** At most this many people are called up to one activity. */
export const INVITEES_MAX = 200;

/**
 * Who is called up. With inviteesOnly the roster's participants are the
 * people in personIds (the groups' members on the start); without it the
 * whole groups take part and personIds must be empty.
 */
export const SetInviteesSchema = z
  .object({
    inviteesOnly: z.boolean(),
    personIds: z.array(z.uuid()).max(INVITEES_MAX),
  })
  .strict()
  .refine((v) => v.inviteesOnly || v.personIds.length === 0, {
    message: "personIds must be empty without inviteesOnly",
    path: ["personIds"],
  })
  .openapi("SetInviteesRequest");
export type SetInviteesInput = z.input<typeof SetInviteesSchema>;

export const InviteesSchema = z
  .object({
    activityId: z.uuid(),
    inviteesOnly: z.boolean(),
    /** Everyone who may be called up (the groups' members on the start), and whether they are. */
    candidates: z.array(z.object({ person: PersonSummarySchema, invited: z.boolean() })),
    /** How many are called up (protected members the viewer may not see included). */
    invitedCount: z.number().int(),
  })
  .openapi("Invitees");
export type Invitees = z.infer<typeof InviteesSchema>;

// --- Attendance -------------------------------------------------------------------

/** A grant rule a session does not meet (country pack; codes, never values). */
export const GrantHintSchema = z
  .object({
    /** e.g. "lok". */
    scheme: z.string(),
    code: z.string(),
  })
  .openapi("GrantHint");
export type GrantHint = z.infer<typeof GrantHintSchema>;

export const AttendanceMarkSchema = z
  .object({
    person: PersonSummarySchema,
    role: z.enum(ATTENDANCE_ROLES),
    status: z.enum(ATTENDANCE_STATUSES).nullable(),
    /** From the answer (attending → present, not attending → excused); not saved until sent. */
    suggested: z.enum(ATTENDANCE_STATUSES).nullable(),
    /** Not a member of the activity's groups on its start. */
    guest: z.boolean(),
    recordedAt: z.iso.datetime({ offset: true }).nullable(),
    correctedReason: z.string().nullable(),
  })
  .openapi("AttendanceMark");
export type AttendanceMark = z.infer<typeof AttendanceMarkSchema>;

export const AttendanceSchema = z
  .object({
    activityId: z.uuid(),
    /** Past the club's lock: only club managers and registrars correct, with a reason. */
    locked: z.boolean(),
    /** Not open yet (more than an hour before the start) or cancelled. */
    open: z.boolean(),
    canRecord: z.boolean(),
    canCorrect: z.boolean(),
    participants: z.array(AttendanceMarkSchema),
    leaders: z.array(AttendanceMarkSchema),
    /** Protected people on the list (the app blocks screenshots while it shows them). */
    hasProtected: z.boolean(),
    /** Grant rules the session does not meet, for the leaders (empty when none apply). */
    hints: z.array(GrantHintSchema),
  })
  .openapi("Attendance");
export type Attendance = z.infer<typeof AttendanceSchema>;

export const RecordAttendanceSchema = z
  .object({
    marks: z
      .array(
        z
          .object({
            personId: z.uuid(),
            status: z.enum(ATTENDANCE_STATUSES),
            role: z.enum(ATTENDANCE_ROLES).default("participant"),
            /** When the mark was taken on the device (offline outbox); the newer mark wins. */
            recordedAt: z.iso.datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ATTENDANCE_BATCH_MAX),
    /** Required for corrections after the lock; never personal data. */
    correctedReason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .openapi("RecordAttendanceRequest");
export type RecordAttendanceInput = z.input<typeof RecordAttendanceSchema>;

export const RecordAttendanceResultSchema = z
  .object({
    attendance: AttendanceSchema,
    /** Marks not applied because a newer one was already recorded (their current value is in attendance). */
    stale: z.array(z.uuid()),
  })
  .openapi("RecordAttendanceResult");
export type RecordAttendanceResult = z.infer<typeof RecordAttendanceResultSchema>;

export const GroupAttendanceQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type GroupAttendanceQuery = z.infer<typeof GroupAttendanceQuerySchema>;

export const GroupAttendanceSchema = z
  .object({
    timeZone: z.string(),
    /** Sessions held in the range (not cancelled), with the number present. */
    sessions: z.array(
      z.object({
        activityId: z.uuid(),
        title: z.string(),
        kind: z.string(),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        recorded: z.boolean(),
        present: z.number().int(),
        leadersPresent: z.number().int(),
        hints: z.array(GrantHintSchema),
      }),
    ),
    /** Per member of the period (keyset by person). */
    members: z.array(
      z.object({
        person: PersonSummarySchema,
        sessions: z.number().int(),
        present: z.number().int(),
        absent: z.number().int(),
        excused: z.number().int(),
        /** present / sessions with a mark, 0–1; null without marks. */
        rate: z.number().nullable(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("GroupAttendance");
export type GroupAttendance = z.infer<typeof GroupAttendanceSchema>;
