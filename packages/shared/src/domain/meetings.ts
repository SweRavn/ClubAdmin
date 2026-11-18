// SPDX-License-Identifier: AGPL-3.0-only
// Meetings and tasks (P2.4 part B, ADR 0049 decisions 3–5, ADR 0052): a
// meeting (a board's activity or the annual meeting's event) has an agenda
// of items with their minutes, decisions, papers and action items; the
// agenda is assembled into minutes (a governing document). Action items are
// tasks, listed in "Mina uppgifter". People appear only as PersonSummary
// from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

export const MEETING_KINDS = ["annual_meeting", "extra_meeting", "board_meeting", "other"] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

// Duty shifts (P2.6, ADR 0050) are tasks too; only action items are marked by their assignee.
export const TASK_KINDS = ["action_item", "duty_shift"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_ASSIGNMENT_STATUSES = ["planned", "done", "missed"] as const;
export type TaskAssignmentStatus = (typeof TASK_ASSIGNMENT_STATUSES)[number];

/** A meeting's agenda has at most this many items. */
export const AGENDA_MAX_ITEMS = 60;
/** A club keeps at most this many agenda templates of its own. */
export const AGENDA_TEMPLATES_MAX = 50;

const title = (max: number) => z.string().trim().min(1).max(max);
const day = z.iso.date();

// --- Templates ----------------------------------------------------------------

export const AgendaTemplateItemSchema = z
  .object({
    title: title(200),
    durationMinutes: z.number().int().min(1).max(600).nullish(),
  })
  .strict()
  .openapi("AgendaTemplateItem");

export const AgendaTemplateSchema = z
  .object({
    /** None: the country pack's default (start a club template from it). */
    id: z.uuid().nullable(),
    /** The country pack's key (its defaults only). */
    packKey: z.string().nullable(),
    meetingKind: z.enum(MEETING_KINDS),
    name: z.string(),
    items: z.array(AgendaTemplateItemSchema),
  })
  .openapi("AgendaTemplate");
export type AgendaTemplate = z.infer<typeof AgendaTemplateSchema>;

export const AgendaTemplateListSchema = z
  .object({
    /** The club's own templates (by name), then the country pack's defaults. */
    items: z.array(AgendaTemplateSchema),
    canManage: z.boolean(),
  })
  .openapi("AgendaTemplateList");
export type AgendaTemplateList = z.infer<typeof AgendaTemplateListSchema>;

export const PutAgendaTemplatesSchema = z
  .object({
    /** The club's templates, all of them: kept by ID, new ones without, missing ones removed. */
    templates: z
      .array(
        z
          .object({
            id: z.uuid().optional(),
            meetingKind: z.enum(MEETING_KINDS),
            name: title(120),
            items: z.array(AgendaTemplateItemSchema).min(1).max(AGENDA_MAX_ITEMS),
          })
          .strict(),
      )
      .max(AGENDA_TEMPLATES_MAX),
  })
  .strict()
  .openapi("PutAgendaTemplates");
export type PutAgendaTemplatesInput = z.infer<typeof PutAgendaTemplatesSchema>;

// --- Agendas ------------------------------------------------------------------

export const ActivityAgendaParamsSchema = z.object({ activityId: z.uuid() });
export const EventAgendaParamsSchema = z.object({ eventId: z.uuid() });

export const MeetingRefSchema = z
  .object({ kind: z.enum(["activity", "event"]), id: z.uuid(), title: z.string() })
  .openapi("MeetingRef");
export type MeetingRef = z.infer<typeof MeetingRefSchema>;

export const ActionAssigneeSchema = z
  .object({
    assignmentId: z.uuid(),
    /** None: hidden (protected identity). */
    person: PersonSummarySchema.nullable(),
    status: z.enum(TASK_ASSIGNMENT_STATUSES),
  })
  .openapi("ActionAssignee");

export const ActionItemSchema = z
  .object({
    taskId: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    dueDate: day.nullable(),
    assignees: z.array(ActionAssigneeSchema),
  })
  .openapi("ActionItem");
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const AgendaItemSchema = z
  .object({
    id: z.uuid(),
    position: z.number().int(),
    title: z.string(),
    /** None: no presenter, or hidden (protected identity). */
    presenter: PersonSummarySchema.nullable(),
    durationMinutes: z.number().int().nullable(),
    /** The minutes written for the item (Markdown). */
    minutes: z.string().nullable(),
    decisions: z.array(z.object({ id: z.uuid(), text: z.string() })),
    /** Papers: documents the meeting's readers may read. */
    papers: z.array(z.object({ id: z.uuid(), name: z.string() })),
    actions: z.array(ActionItemSchema),
  })
  .openapi("AgendaItem");
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const AgendaSchema = z
  .object({
    meeting: MeetingRefSchema,
    items: z.array(AgendaItemSchema),
    /** The governing document the agenda was assembled into, if any. */
    minutesDocumentId: z.uuid().nullable(),
    canEdit: z.boolean(),
  })
  .openapi("Agenda");
export type Agenda = z.infer<typeof AgendaSchema>;

export const PutAgendaSchema = z
  .object({
    /** The whole agenda in order: items kept by ID, new ones without, missing ones removed. */
    items: z
      .array(
        z
          .object({
            id: z.uuid().optional(),
            title: title(200),
            presenterPersonId: z.uuid().nullish(),
            durationMinutes: z.number().int().min(1).max(600).nullish(),
            minutes: z.string().max(50_000).nullish(),
            decisions: z.array(title(5000)).max(100).optional(),
            paperIds: z.array(z.uuid()).max(20).optional(),
            actions: z
              .array(
                z
                  .object({
                    taskId: z.uuid().optional(),
                    title: title(200),
                    description: z.string().max(10_000).nullish(),
                    dueDate: day.nullish(),
                    assignees: z
                      .array(
                        z
                          .object({
                            personId: z.uuid(),
                            status: z.enum(TASK_ASSIGNMENT_STATUSES).optional(),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(10),
                  })
                  .strict(),
              )
              .max(20)
              .optional(),
          })
          .strict(),
      )
      .max(AGENDA_MAX_ITEMS),
  })
  .strict()
  .openapi("PutAgenda");
export type PutAgendaInput = z.infer<typeof PutAgendaSchema>;

export const AssembleMinutesSchema = z
  .object({
    /** The series the minutes go in (needed the first time). */
    seriesId: z.uuid().optional(),
  })
  .strict()
  .openapi("AssembleMinutes");
export type AssembleMinutesInput = z.infer<typeof AssembleMinutesSchema>;

export const MinutesAssembledSchema = z
  .object({ documentId: z.uuid(), versionId: z.uuid() })
  .openapi("MinutesAssembled");

// --- Tasks ("Mina uppgifter") ---------------------------------------------------

export const MyTasksQuerySchema = z.object({
  /** `open`: planned; `closed`: done or missed. */
  status: z.enum(["open", "closed"]).default("open"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MyTasksQuery = z.infer<typeof MyTasksQuerySchema>;

export const MyTaskSchema = z
  .object({
    assignmentId: z.uuid(),
    taskId: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    groupId: z.uuid().nullable(),
    groupName: z.string().nullable(),
    kind: z.enum(TASK_KINDS),
    title: z.string(),
    description: z.string().nullable(),
    dueDate: day.nullable(),
    startsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime().nullable(),
    /** Whose task: the caller or a ward (none: hidden). */
    person: PersonSummarySchema.nullable(),
    status: z.enum(TASK_ASSIGNMENT_STATUSES),
    markedAt: z.iso.datetime().nullable(),
    /** The meeting it was decided at. */
    meeting: MeetingRefSchema.nullable(),
  })
  .openapi("MyTask");
export type MyTask = z.infer<typeof MyTaskSchema>;

export const MyTaskPageSchema = z
  .object({ items: z.array(MyTaskSchema), nextCursor: z.uuid().nullable() })
  .openapi("MyTaskPage");
export type MyTaskPage = z.infer<typeof MyTaskPageSchema>;

export const TaskAssignmentParamsSchema = z.object({ assignmentId: z.uuid() });

export const SetTaskStatusSchema = z
  .object({ status: z.enum(TASK_ASSIGNMENT_STATUSES) })
  .strict()
  .openapi("SetTaskStatus");
export type SetTaskStatusInput = z.infer<typeof SetTaskStatusSchema>;
