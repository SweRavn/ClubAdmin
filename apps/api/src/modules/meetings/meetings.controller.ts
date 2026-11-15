// SPDX-License-Identifier: AGPL-3.0-only
// Meetings and tasks (P2.4 part B, ADR 0049, ADR 0052): a meeting's agenda
// (read with the activity or event, edited by whoever may edit it), the
// minutes assembled into a governing document, the club's agenda templates
// and "Mina uppgifter". Presenters and assignees go through the
// PersonPresenter (ADR 0022).

import {
  ActivityAgendaParamsSchema,
  type Agenda,
  AgendaSchema,
  type AgendaTemplateList,
  AgendaTemplateListSchema,
  type AssembleMinutesInput,
  AssembleMinutesSchema,
  ClubParamsSchema,
  EventAgendaParamsSchema,
  MinutesAssembledSchema,
  type MyTaskPage,
  MyTaskPageSchema,
  type MyTasksQuery,
  MyTasksQuerySchema,
  type PersonSummary,
  type PutAgendaInput,
  PutAgendaSchema,
  type PutAgendaTemplatesInput,
  PutAgendaTemplatesSchema,
  type SetTaskStatusInput,
  SetTaskStatusSchema,
  TaskAssignmentParamsSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { type AgendaView, type MeetingKey, MeetingsService } from "./meetings.service.ts";

const TAGS = ["meetings"];

@Controller()
export class MeetingsController {
  private readonly meetings: MeetingsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(meetings: MeetingsService, people: PeopleService, presenter: PersonPresenter) {
    this.meetings = meetings;
    this.people = people;
    this.presenter = presenter;
  }

  /** The people the caller may see among these, in one club. */
  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), unique);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  private meetingOf(
    authz: RequestAuthorization,
    m: MeetingKey,
  ): { clubId: string; canEdit: boolean } {
    if (m.kind === "activity") {
      const activity = resourceOf(authz, "activity");
      return {
        clubId: activity.clubId,
        canEdit: permits(authz.actor, "activity.manage", activity),
      };
    }
    const event = resourceOf(authz, "event");
    return { clubId: event.clubId, canEdit: permits(authz.actor, "event.manage", event) };
  }

  private async view(authz: RequestAuthorization, m: MeetingKey): Promise<Agenda> {
    const { clubId, canEdit } = this.meetingOf(authz, m);
    const agenda: AgendaView = await this.meetings.agenda(tenantContext(authz, clubId), m);
    const actions = [...agenda.actions.values()].flat();
    const persons = await this.persons(authz, clubId, [
      ...agenda.items.flatMap((i) => (i.presenterPersonId ? [i.presenterPersonId] : [])),
      ...actions.flatMap((a) => a.assignees.map((x) => x.personId)),
    ]);
    return {
      meeting: { kind: m.kind, id: m.id, title: agenda.meeting.title },
      items: agenda.items.map((i) => ({
        id: i.id,
        position: i.position,
        title: i.title,
        presenter: (i.presenterPersonId && persons.get(i.presenterPersonId)) || null,
        durationMinutes: i.durationMinutes,
        minutes: i.minutes,
        decisions: agenda.decisions.get(i.id) ?? [],
        papers: agenda.papers.get(i.id) ?? [],
        actions: (agenda.actions.get(i.id) ?? []).map((a) => ({
          taskId: a.taskId,
          title: a.title,
          description: a.description,
          dueDate: a.dueDate,
          assignees: a.assignees.map((x) => ({
            assignmentId: x.assignmentId,
            person: persons.get(x.personId) ?? null,
            status: x.status,
          })),
        })),
      })),
      minutesDocumentId: agenda.minutesDocumentId,
      canEdit,
    };
  }

  // --- Templates ----------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/agenda-templates",
    summary: "The club's agenda templates and its country pack's defaults",
    tags: TAGS,
    access: { permission: "club.documents.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: AgendaTemplateListSchema,
  })
  async templates(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<AgendaTemplateList> {
    const items = await this.meetings.templates(tenantContext(authz, params.clubId));
    return {
      items,
      canManage: permits(authz.actor, "club.governing_documents.manage", {
        kind: "club",
        clubId: params.clubId,
      }),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/agenda-templates",
    summary: "Replace the club's agenda templates",
    tags: TAGS,
    access: { permission: "club.governing_documents.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: PutAgendaTemplatesSchema },
    response: AgendaTemplateListSchema,
  })
  async putTemplates(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: PutAgendaTemplatesInput,
  ): Promise<AgendaTemplateList> {
    await this.meetings.putTemplates(tenantContext(authz, params.clubId), body);
    return this.templates(authz, params);
  }

  // --- Agendas ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/agenda",
    summary: "A meeting's agenda: items, minutes, decisions, papers and action items",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: ActivityAgendaParamsSchema },
    response: AgendaSchema,
  })
  activityAgenda(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
  ): Promise<Agenda> {
    return this.view(authz, { kind: "activity", id: params.activityId });
  }

  @Endpoint({
    method: "PUT",
    path: "activities/:activityId/agenda",
    summary: "Replace a meeting's agenda (items kept by ID)",
    tags: TAGS,
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityAgendaParamsSchema, body: PutAgendaSchema },
    response: AgendaSchema,
  })
  async putActivityAgenda(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
    @Body() body: PutAgendaInput,
  ): Promise<Agenda> {
    const m: MeetingKey = { kind: "activity", id: params.activityId };
    await this.meetings.putAgenda(tenantContext(authz, this.meetingOf(authz, m).clubId), m, body);
    return this.view(authz, m);
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/minutes",
    summary: "Assemble the meeting's minutes into a governing document (its draft)",
    tags: TAGS,
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityAgendaParamsSchema, body: AssembleMinutesSchema },
    response: MinutesAssembledSchema,
  })
  activityMinutes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
    @Body() body: AssembleMinutesInput,
  ): Promise<{ documentId: string; versionId: string }> {
    const m: MeetingKey = { kind: "activity", id: params.activityId };
    return this.meetings.assembleMinutes(
      tenantContext(authz, this.meetingOf(authz, m).clubId),
      m,
      body,
    );
  }

  @Endpoint({
    method: "GET",
    path: "events/:eventId/agenda",
    summary: "The annual (or an extra) meeting's agenda",
    tags: TAGS,
    access: { permission: "event.read", resource: "event" },
    request: { params: EventAgendaParamsSchema },
    response: AgendaSchema,
  })
  eventAgenda(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
  ): Promise<Agenda> {
    return this.view(authz, { kind: "event", id: params.eventId });
  }

  @Endpoint({
    method: "PUT",
    path: "events/:eventId/agenda",
    summary: "Replace the annual meeting's agenda (items kept by ID)",
    tags: TAGS,
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventAgendaParamsSchema, body: PutAgendaSchema },
    response: AgendaSchema,
  })
  async putEventAgenda(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
    @Body() body: PutAgendaInput,
  ): Promise<Agenda> {
    const m: MeetingKey = { kind: "event", id: params.eventId };
    await this.meetings.putAgenda(tenantContext(authz, this.meetingOf(authz, m).clubId), m, body);
    return this.view(authz, m);
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/minutes",
    summary: "Assemble the annual meeting's minutes into a governing document (its draft)",
    tags: TAGS,
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventAgendaParamsSchema, body: AssembleMinutesSchema },
    response: MinutesAssembledSchema,
  })
  eventMinutes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
    @Body() body: AssembleMinutesInput,
  ): Promise<{ documentId: string; versionId: string }> {
    const m: MeetingKey = { kind: "event", id: params.eventId };
    return this.meetings.assembleMinutes(
      tenantContext(authz, this.meetingOf(authz, m).clubId),
      m,
      body,
    );
  }

  // --- "Mina uppgifter" -------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/tasks",
    summary: "Mina uppgifter: the tasks of the caller and their wards, by day",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: MyTasksQuerySchema },
    response: MyTaskPageSchema,
  })
  async myTasks(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: MyTasksQuery,
  ): Promise<MyTaskPage> {
    const page = await this.meetings.myTasks(authz.context, query);
    const byClub = new Map<string, string[]>();
    for (const r of page.rows) byClub.set(r.clubId, [...(byClub.get(r.clubId) ?? []), r.personId]);
    const persons = new Map<string, PersonSummary>();
    for (const [clubId, ids] of byClub) {
      for (const [id, p] of await this.persons(authz, clubId, ids))
        persons.set(`${clubId}:${id}`, p);
    }
    return {
      items: page.rows.map((r) => ({
        assignmentId: r.assignmentId,
        taskId: r.taskId,
        clubId: r.clubId,
        clubName: r.clubName,
        groupId: r.groupId,
        groupName: r.groupName,
        kind: r.kind,
        title: r.title,
        description: r.description,
        dueDate: r.dueDate,
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
        person: persons.get(`${r.clubId}:${r.personId}`) ?? null,
        status: r.status,
        markedAt: r.markedAt?.toISOString() ?? null,
        meeting:
          r.meetingTitle && (r.activityId || r.eventId)
            ? {
                kind: r.activityId ? "activity" : "event",
                id: (r.activityId ?? r.eventId)!,
                title: r.meetingTitle,
              }
            : null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/task-assignments/:assignmentId/status",
    summary: "Mark one of my (or my ward's) tasks done, missed or planned again",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: TaskAssignmentParamsSchema, body: SetTaskStatusSchema },
    response: z.null(),
    status: 204,
  })
  async setMyTaskStatus(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { assignmentId: string },
    @Body() body: SetTaskStatusInput,
  ): Promise<null> {
    await this.meetings.setMyTaskStatus(authz.context, params.assignmentId, body);
    return null;
  }
}
