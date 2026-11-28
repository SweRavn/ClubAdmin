// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6, ADR 0050 and its amendment of 2026-11-18): the
// club's duty types (with the contact with children each means), shifts
// (tasks of kind `duty_shift`, ADR 0052) in a group or the club, sign-up and
// assignment with the player a shift counts for, and quotas per group and
// season. People appear only as PersonSummary from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { TASK_ASSIGNMENT_STATUSES } from "./meetings.ts";

/** The contact with children a duty means (the background-check categories of P2.8 map to it). */
export const DUTY_CHILD_CONTACTS = ["none", "with_children", "alone_with_children"] as const;
export type DutyChildContact = (typeof DUTY_CHILD_CONTACTS)[number];

/** Who sees whom on which shift and others' quotas (leaders always see everything). */
export const DUTY_VISIBILITIES = ["open", "names", "leaders"] as const;
export type DutyVisibility = (typeof DUTY_VISIBILITIES)[number];

export const DUTY_ASSIGNMENT_SOURCES = ["assigned", "signup", "swap"] as const;

/** A shift needs at most this many people. */
export const DUTY_SHIFT_MAX_NEEDED = 50;
/** A list of shifts covers at most this many days, and holds at most this many. */
export const DUTY_SHIFT_RANGE_DAYS = 400;
export const DUTY_SHIFT_LIST_MAX = 300;

const name = z.string().trim().min(1).max(100);
const instant = z.iso.datetime({ offset: true });

// --- Duty types -------------------------------------------------------------------

export const DutyTypeSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    instruction: z.string().nullable(),
    instructionDocumentIds: z.array(z.uuid()),
    minAge: z.number().int().nullable(),
    childContact: z.enum(DUTY_CHILD_CONTACTS),
    /** Prepared for the qualifications register (Phase 4); not checked. */
    requiredQualifications: z.array(z.string()),
    archived: z.boolean(),
  })
  .openapi("DutyType");
export type DutyType = z.infer<typeof DutyTypeSchema>;

export const DutyTypeListSchema = z
  .object({
    items: z.array(DutyTypeSchema),
    /** Whether the club may use `alone_with_children` (its country pack and its own setting). */
    aloneWithChildrenAllowed: z.boolean(),
    canManage: z.boolean(),
  })
  .openapi("DutyTypeList");
export type DutyTypeList = z.infer<typeof DutyTypeListSchema>;

export const DutyTypeQuerySchema = z.object({
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export type DutyTypeQuery = z.infer<typeof DutyTypeQuerySchema>;

export const CreateDutyTypeSchema = z
  .object({
    name,
    instruction: z.string().trim().max(2000).nullish(),
    instructionDocumentIds: z.array(z.uuid()).max(10).default([]),
    minAge: z.number().int().min(0).max(99).nullish(),
    childContact: z.enum(DUTY_CHILD_CONTACTS).default("none"),
    requiredQualifications: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  })
  .strict()
  .openapi("CreateDutyType");
export type CreateDutyTypeInput = z.input<typeof CreateDutyTypeSchema>;

export const UpdateDutyTypeSchema = z
  .object({
    name,
    instruction: z.string().trim().max(2000).nullable(),
    instructionDocumentIds: z.array(z.uuid()).max(10),
    minAge: z.number().int().min(0).max(99).nullable(),
    childContact: z.enum(DUTY_CHILD_CONTACTS),
    requiredQualifications: z.array(z.string().trim().min(1).max(100)).max(20),
    archived: z.boolean(),
  })
  .partial()
  .strict()
  .openapi("UpdateDutyType");
export type UpdateDutyTypeInput = z.input<typeof UpdateDutyTypeSchema>;

export const DutyTypeParamsSchema = z.object({ clubId: z.uuid(), typeId: z.uuid() });

// --- The club's settings ------------------------------------------------------------

export const DutySettingsSchema = z
  .object({
    visibility: z.enum(DUTY_VISIBILITIES),
    groupsMayChangeVisibility: z.boolean(),
    /** The club's own ban on an adult alone with children. */
    aloneWithChildrenForbidden: z.boolean(),
    /** The country pack forbids it (the club's setting cannot allow it then). */
    countryForbidsAloneWithChildren: z.boolean(),
  })
  .openapi("DutySettings");
export type DutySettings = z.infer<typeof DutySettingsSchema>;

export const PutDutySettingsSchema = z
  .object({
    visibility: z.enum(DUTY_VISIBILITIES),
    groupsMayChangeVisibility: z.boolean(),
    aloneWithChildrenForbidden: z.boolean(),
  })
  .strict()
  .openapi("PutDutySettings");
export type PutDutySettingsInput = z.infer<typeof PutDutySettingsSchema>;

// --- Shifts -------------------------------------------------------------------------

export const DutyAssignmentSchema = z
  .object({
    id: z.uuid(),
    /** Who does it (none: hidden, by protected identity or the visibility setting). */
    person: PersonSummarySchema.nullable(),
    /** The player whose quota it counts for (none: nobody's, or hidden). */
    countsFor: PersonSummarySchema.nullable(),
    source: z.enum(DUTY_ASSIGNMENT_SOURCES),
    status: z.enum(TASK_ASSIGNMENT_STATUSES),
    /** The caller's own or their family's. */
    mine: z.boolean(),
    /**
     * P2.8: the person has no valid background check the shift needs (shown
     * to its planners; the shift is not cancelled automatically).
     */
    missingBackgroundCheck: z.boolean().default(false),
  })
  .openapi("DutyAssignment");
export type DutyAssignment = z.infer<typeof DutyAssignmentSchema>;

export const DutyShiftSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    groupId: z.uuid().nullable(),
    groupName: z.string().nullable(),
    dutyType: z.object({
      id: z.uuid(),
      name: z.string(),
      minAge: z.number().int().nullable(),
      childContact: z.enum(DUTY_CHILD_CONTACTS),
      /** P2.8: the background-check category the shift needs (null: none). */
      backgroundCheckCategory: z
        .enum(["regular_contact_with_children", "alone_with_children", "overnight", "board"])
        .nullable()
        .default(null),
    }),
    /**
     * P2.8: the caller has no valid background check the shift needs, so it
     * is not offered to them (sign-up is refused with background_check_required).
     */
    backgroundCheckRequired: z.boolean().default(false),
    /** The shift's own title; none: the type's name. */
    title: z.string(),
    note: z.string().nullable(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timeZone: z.string(),
    locationId: z.uuid().nullable(),
    locationName: z.string().nullable(),
    activityId: z.uuid().nullable(),
    eventId: z.uuid().nullable(),
    needed: z.number().int(),
    filled: z.number().int(),
    assignments: z.array(DutyAssignmentSchema),
  })
  .openapi("DutyShift");
export type DutyShift = z.infer<typeof DutyShiftSchema>;

export const DutyShiftListSchema = z
  .object({
    /** Unstaffed first, then by time. */
    items: z.array(DutyShiftSchema),
    /** People of the caller's family who may sign up, with the players a shift could count for. */
    canSignUp: z.boolean(),
  })
  .openapi("DutyShiftList");
export type DutyShiftList = z.infer<typeof DutyShiftListSchema>;

export const DutyShiftRangeQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.to >= v.from, { message: "to before from", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= DUTY_SHIFT_RANGE_DAYS, {
    message: "range too long",
    path: ["to"],
  });
export type DutyShiftRangeQuery = z.infer<typeof DutyShiftRangeQuerySchema>;

export const CreateDutyShiftSchema = z
  .object({
    dutyTypeId: z.uuid(),
    /** None: the type's name. */
    title: z.string().trim().min(1).max(200).nullish(),
    note: z.string().trim().max(2000).nullish(),
    startsAt: instant,
    endsAt: instant,
    locationId: z.uuid().nullish(),
    needed: z.number().int().min(1).max(DUTY_SHIFT_MAX_NEEDED).default(1),
    /** The activity (or event session) it belongs to. */
    activityId: z.uuid().nullish(),
    eventId: z.uuid().nullish(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .openapi("CreateDutyShift");
export type CreateDutyShiftInput = z.input<typeof CreateDutyShiftSchema>;

export const UpdateDutyShiftSchema = z
  .object({
    title: z.string().trim().min(1).max(200).nullable(),
    note: z.string().trim().max(2000).nullable(),
    startsAt: instant,
    endsAt: instant,
    locationId: z.uuid().nullable(),
    needed: z.number().int().min(1).max(DUTY_SHIFT_MAX_NEEDED),
  })
  .partial()
  .strict()
  .openapi("UpdateDutyShift");
export type UpdateDutyShiftInput = z.input<typeof UpdateDutyShiftSchema>;

export const DutyShiftCreatedSchema = z.object({ id: z.uuid() }).openapi("DutyShiftCreated");

export const GroupDutyShiftParamsSchema = z.object({ clubId: z.uuid(), groupId: z.uuid() });
export const GroupDutyShiftIdParamsSchema = GroupDutyShiftParamsSchema.extend({
  shiftId: z.uuid(),
});
export const ClubDutyShiftIdParamsSchema = z.object({ clubId: z.uuid(), shiftId: z.uuid() });
export const DutyAssignmentParamsSchema = ClubDutyShiftIdParamsSchema.extend({
  assignmentId: z.uuid(),
});
export const GroupDutyAssignmentParamsSchema = GroupDutyShiftIdParamsSchema.extend({
  assignmentId: z.uuid(),
});

// --- Sign-up and assignment ---------------------------------------------------------

export const DutySignUpSchema = z
  .object({
    /** Who does the shift: the caller or one of their children (none: the caller). */
    personId: z.uuid().nullish(),
    /** The player it counts for; none: chosen when there is exactly one. */
    countsForPersonId: z.uuid().nullish(),
  })
  .strict()
  .openapi("DutySignUp");
export type DutySignUpInput = z.input<typeof DutySignUpSchema>;

export const AssignDutySchema = z
  .object({
    personId: z.uuid(),
    countsForPersonId: z.uuid().nullish(),
  })
  .strict()
  .openapi("AssignDuty");
export type AssignDutyInput = z.input<typeof AssignDutySchema>;

export const DutyAssignmentCreatedSchema = z
  .object({ id: z.uuid(), countsForPersonId: z.uuid().nullable() })
  .openapi("DutyAssignmentCreated");

// --- Quotas -------------------------------------------------------------------------

export const DutyQuotaQuerySchema = z.object({ seasonId: z.uuid() });

export const DutyQuotaSchema = z
  .object({
    groupId: z.uuid(),
    seasonId: z.uuid(),
    /** None: no quota in the season. */
    shiftsPerPlayer: z.number().int().nullable(),
    /** The group's players with their shifts in the season: done and planned apart. */
    players: z.array(
      z.object({
        /** None: hidden (protected identity). */
        person: PersonSummarySchema.nullable(),
        done: z.number().int(),
        planned: z.number().int(),
      }),
    ),
  })
  .openapi("DutyQuota");
export type DutyQuota = z.infer<typeof DutyQuotaSchema>;

export const PutDutyQuotaSchema = z
  .object({
    seasonId: z.uuid(),
    /** None: no quota. */
    shiftsPerPlayer: z.number().int().min(0).max(100).nullable(),
  })
  .strict()
  .openapi("PutDutyQuota");
export type PutDutyQuotaInput = z.infer<typeof PutDutyQuotaSchema>;

// --- Marking done or missed (part B) --------------------------------------------------

export const SetDutyStatusSchema = z
  .object({ status: z.enum(TASK_ASSIGNMENT_STATUSES) })
  .strict()
  .openapi("SetDutyStatus");
export type SetDutyStatusInput = z.infer<typeof SetDutyStatusSchema>;

// --- A group's visibility (part B) ----------------------------------------------------

export const GroupDutySettingsSchema = z
  .object({
    /** The group's own choice; none: the club's. */
    visibility: z.enum(DUTY_VISIBILITIES).nullable(),
    /** What applies in the group. */
    effective: z.enum(DUTY_VISIBILITIES),
    /** The club lets its groups choose. */
    mayChange: z.boolean(),
  })
  .openapi("GroupDutySettings");
export type GroupDutySettings = z.infer<typeof GroupDutySettingsSchema>;

export const PutGroupDutySettingsSchema = z
  .object({ visibility: z.enum(DUTY_VISIBILITIES).nullable() })
  .strict()
  .openapi("PutGroupDutySettings");
export type PutGroupDutySettingsInput = z.infer<typeof PutGroupDutySettingsSchema>;

// --- Swaps (part B) ------------------------------------------------------------------

export const DUTY_SWAP_KINDS = ["offer", "request"] as const;
export const DUTY_SWAP_STATUSES = ["open", "done", "declined", "withdrawn"] as const;

export const CreateDutySwapSchema = z
  .object({
    /** `offer`: the assignee gives the shift away; `request`: someone asks to take it over. */
    kind: z.enum(DUTY_SWAP_KINDS),
    /** A request: who would take it (the caller or a child; none: the caller). */
    personId: z.uuid().nullish(),
    /** A request: the player it would then count for. */
    countsForPersonId: z.uuid().nullish(),
  })
  .strict()
  .openapi("CreateDutySwap");
export type CreateDutySwapInput = z.input<typeof CreateDutySwapSchema>;

export const TakeDutySwapSchema = z
  .object({
    personId: z.uuid().nullish(),
    countsForPersonId: z.uuid().nullish(),
  })
  .strict()
  .openapi("TakeDutySwap");
export type TakeDutySwapInput = z.input<typeof TakeDutySwapSchema>;

export const DutySwapSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(DUTY_SWAP_KINDS),
    status: z.enum(DUTY_SWAP_STATUSES),
    assignmentId: z.uuid(),
    shift: z.object({
      id: z.uuid(),
      clubId: z.uuid(),
      groupId: z.uuid().nullable(),
      groupName: z.string().nullable(),
      title: z.string(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
    }),
    /** Who holds the shift (none: hidden by protected identity or visibility). */
    holder: PersonSummarySchema.nullable(),
    /** A request's would-be taker. */
    taker: PersonSummarySchema.nullable(),
    /** The caller's family started it. */
    mine: z.boolean(),
    /** An offer the caller's family may take, a request the caller's family may accept. */
    canTake: z.boolean(),
    canAccept: z.boolean(),
  })
  .openapi("DutySwap");
export type DutySwap = z.infer<typeof DutySwapSchema>;

export const DutySwapParamsSchema = z.object({ swapId: z.uuid() });
export const MyDutyAssignmentParamsSchema = z.object({ assignmentId: z.uuid() });

// --- "Mina uppgifter": my family's duties in a club (part B) ----------------------------

export const MyDutiesQuerySchema = z.object({ clubId: z.uuid() });

export const MyDutiesSchema = z
  .object({
    clubId: z.uuid(),
    /** Each of the family's players' quotas in the current season, per group with a quota. */
    quotas: z.array(
      z.object({
        groupId: z.uuid(),
        groupName: z.string(),
        seasonId: z.uuid(),
        player: PersonSummarySchema.nullable(),
        shiftsPerPlayer: z.number().int(),
        done: z.number().int(),
        planned: z.number().int(),
      }),
    ),
    /** Coming shifts with free places in the family's groups (and the club's own). */
    openShifts: z.array(DutyShiftSchema),
    /** Open swaps in the family's groups: offers to take, requests to answer, the family's own. */
    swaps: z.array(DutySwapSchema),
  })
  .openapi("MyDuties");
export type MyDuties = z.infer<typeof MyDutiesSchema>;

// --- "Mitt schema" (part B) ------------------------------------------------------------

export const ScheduleDutySchema = z
  .object({
    assignmentId: z.uuid(),
    shiftId: z.uuid(),
    club: z.object({ id: z.uuid(), name: z.string(), timeZone: z.string() }),
    groupName: z.string().nullable(),
    title: z.string(),
    typeName: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    place: z.string().nullable(),
    activityId: z.uuid().nullable(),
    /** Who does it (the caller or a ward). */
    person: PersonSummarySchema.nullable(),
    status: z.enum(TASK_ASSIGNMENT_STATUSES),
  })
  .openapi("ScheduleDuty");
export type ScheduleDuty = z.infer<typeof ScheduleDutySchema>;

// --- Statistics (part B) ---------------------------------------------------------------

export const DutyStatsQuerySchema = z.object({ seasonId: z.uuid() });
